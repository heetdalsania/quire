import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ATTR_RUN,
  type Author,
  CommentStore,
  committedText,
  insertAttributed,
  isRangeLocked,
  knownAuthors,
  pendingSuggestions,
  proposeDelete,
  readPolicy,
  runAt,
  sections,
  spans,
  summarise,
  writePolicy,
} from "@quire/bridge";
import { AgentSession } from "./session.js";

export interface McpOptions {
  /** Base URL of the running Quire server. */
  serverUrl: string;
  agentName: string;
  agentColor: string;
  /** Model identifier recorded in provenance, e.g. "claude-opus-5". */
  model?: string;
  /**
   * A role this agent plays, e.g. "editor" or "fact-checker". Several agents can hold a
   * document at once; the role is what makes their cursors and spans legible.
   */
  role?: string;
  /** Defer to a human whose cursor is inside the range being edited. */
  polite?: boolean;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export async function createQuireMcpServer(options: McpOptions): Promise<McpServer> {
  const author: Author = {
    id: `agent-${options.agentName.toLowerCase().replace(/\W+/g, "-")}${options.role ? `-${options.role}` : ""}`,
    name: options.role ? `${options.agentName} (${options.role})` : options.agentName,
    color: options.agentColor,
    kind: "agent",
  };
  const model = options.model ?? null;

  /**
   * The politeness protocol.
   *
   * Nothing else that edits files can do this: it needs to see where a person's cursor is,
   * live. Rather than colliding with someone mid-sentence, an edit inside their working
   * range becomes a suggestion they can take or leave.
   */
  const yieldToHuman = (
    session: AgentSession,
    from: number,
    to: number,
  ): { defer: boolean; who?: string } => {
    if (options.polite === false) return { defer: false };
    const near = session.humanCursors().find((c) => c.index >= from - 120 && c.index <= to + 120);
    return near ? { defer: true, who: near.name } : { defer: false };
  };

  /** Refuse an edit that lands in a section the document has locked against agents. */
  const checkLock = (session: AgentSession, from: number, to: number): string | null => {
    const policy = readPolicy(session.doc);
    const hit = isRangeLocked(session.text.toString(), policy.lockedSections, from, to);
    return hit ? `"${hit.heading}" is locked against agent edits in this document.` : null;
  };

  const sessions = new Map<string, AgentSession>();

  /**
   * Join a document's live session, reusing an existing one.
   *
   * `mustExist` is the default: joining an unknown path would otherwise mint an empty
   * document, and an agent that typos a filename would silently create a new one rather
   * than reporting that it could not find the file.
   */
  const join = async (path: string, mustExist = true): Promise<AgentSession> => {
    if (mustExist && !sessions.has(path)) {
      const files = await listFiles();
      if (!files.includes(path)) {
        throw new Error(
          `No document at ${path}. Existing documents: ${files.slice(0, 20).join(", ") || "(none)"}`,
        );
      }
    }
    let session = sessions.get(path);
    if (!session) {
      session = new AgentSession(options.serverUrl, path, author);
      await session.connect();
      sessions.set(path, session);
    }
    return session;
  };

  /** Wrap a handler so a thrown error becomes a tool error rather than a transport fault. */
  const guard =
    <A>(fn: (args: A) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>) =>
    async (args: A) => {
      try {
        return await fn(args);
      } catch (error) {
        return fail((error as Error).message);
      }
    };

  const listFiles = async (): Promise<string[]> => {
    const res = await fetch(new URL("/api/files", options.serverUrl));
    if (!res.ok) throw new Error(`Quire server returned ${res.status}`);
    return ((await res.json()) as { files: string[] }).files;
  };

  const server = new McpServer({ name: "quire", version: "0.1.0" });

  server.registerTool(
    "list_documents",
    {
      title: "List documents",
      description: "List every Markdown document in the Quire vault.",
      inputSchema: {},
    },
    async () => {
      const files = await listFiles();
      return ok(files.length ? files.join("\n") : "(vault is empty)");
    },
  );

  server.registerTool(
    "read_document",
    {
      title: "Read document",
      description:
        "Read a document's current text. By default this includes any pending suggestions " +
        "so that character offsets match what edit_document expects.",
      inputSchema: {
        path: z.string().describe("Vault-relative path, e.g. specs/api.md"),
        committed_only: z
          .boolean()
          .optional()
          .describe("Return only text that has been accepted onto disk."),
      },
    },
    guard(async ({ path, committed_only }: { path: string; committed_only?: boolean | undefined }) => {
      const session = await join(path);
      return ok(committed_only ? committedText(session.text) : session.text.toString());
    }),
  );

  server.registerTool(
    "edit_document",
    {
      title: "Edit document",
      description:
        "Replace an exact string in a document, live, in the same session as any human " +
        "editors. The edit is attributed to this agent and is separately undoable. With " +
        "suggest=true the change is proposed rather than applied: it becomes visible in " +
        "the editor for a human to accept or reject, and does NOT reach the file on disk " +
        "until accepted.",
      inputSchema: {
        path: z.string(),
        old_text: z.string().describe("Exact text to replace. Must occur exactly once."),
        new_text: z.string(),
        suggest: z.boolean().optional().describe("Propose the change instead of applying it."),
        reason: z
          .string()
          .optional()
          .describe("Why this edit is being made. Recorded with the span so a reader can ask later."),
      },
    },
    guard(async ({ path, old_text, new_text, suggest, reason }: { path: string; old_text: string; new_text: string; suggest?: boolean | undefined; reason?: string | undefined }) => {
      const session = await join(path);
      const current = session.text.toString();

      const first = current.indexOf(old_text);
      if (first === -1) return fail(`old_text not found in ${path}`);
      if (current.indexOf(old_text, first + 1) !== -1) {
        return fail(`old_text occurs more than once in ${path}; include more context`);
      }

      const locked = checkLock(session, first, first + old_text.length);
      if (locked) return fail(locked);

      const policy = readPolicy(session.doc);
      if (policy.mode === "read-only") return fail("This document is read-only for agents.");

      const yielded = yieldToHuman(session, first, first + old_text.length);
      const forced = policy.mode === "propose" || yielded.defer;
      const suggestionId = suggest || forced ? `s_${Date.now().toString(36)}` : undefined;

      const runId = session.beginRun("edit_document", reason ?? null, model);
      session.announce({ anchor: first, head: first + old_text.length });

      if (suggestionId) {
        // Show both sides: the removal is proposed, the replacement sits beside it.
        if (old_text.length > 0) {
          proposeDelete(session.text, first, first + old_text.length, author, suggestionId);
        }
        insertAttributed(session.text, first + old_text.length, new_text, author, {
          suggestion: suggestionId,
          run: runId,
        });
      } else {
        session.doc.transact(() => {
          session.text.delete(first, old_text.length);
        }, `author:${author.id}`);
        insertAttributed(session.text, first, new_text, author, { run: runId });
      }

      await session.settle();
      const refused = session.notices.splice(0).join(" ");
      if (refused) return fail(refused);

      if (yielded.defer) {
        return ok(
          `${yielded.who} is working right there, so this went in as suggestion ${suggestionId} rather than editing over them.`,
        );
      }
      return ok(
        suggestionId
          ? `Proposed change to ${path} as suggestion ${suggestionId}. It is visible in the editor and awaiting review; the file on disk is unchanged.`
          : `Applied edit to ${path}. Visible live to every connected editor and written to disk.`,
      );
    }),
  );

  server.registerTool(
    "append_document",
    {
      title: "Append to document",
      description: "Append text to the end of a document, attributed to this agent.",
      inputSchema: {
        path: z.string(),
        text: z.string(),
        suggest: z.boolean().optional(),
      },
    },
    guard(async ({ path, text, suggest }: { path: string; text: string; suggest?: boolean | undefined }) => {
      const session = await join(path);
      const at = session.text.length;
      session.announce({ anchor: at, head: at });
      insertAttributed(session.text, at, text, author, {
        ...(suggest ? { suggestion: `s_${Date.now().toString(36)}` } : {}),
      });
      await session.settle();
      return ok(`Appended ${text.length} characters to ${path}.`);
    }),
  );

  server.registerTool(
    "list_suggestions",
    {
      title: "List pending suggestions",
      description: "List suggestion ids in a document that are still awaiting human review.",
      inputSchema: { path: z.string() },
    },
    guard(async ({ path }: { path: string }) => {
      const session = await join(path);
      const ids = pendingSuggestions(session.text);
      if (ids.length === 0) return ok("No pending suggestions.");
      const detail = ids.map((id) => {
        const inserted = spans(session.text)
          .filter((s) => s.suggestInsert === id)
          .map((s) => session.text.toString().slice(s.from, s.to))
          .join("");
        const removed = spans(session.text)
          .filter((s) => s.suggestDelete === id)
          .map((s) => session.text.toString().slice(s.from, s.to))
          .join("");
        return `${id}\n  + ${JSON.stringify(inserted)}\n  - ${JSON.stringify(removed)}`;
      });
      return ok(detail.join("\n"));
    }),
  );

  server.registerTool(
    "list_comments",
    {
      title: "List comments",
      description: "List comment threads on a document, including orphaned ones.",
      inputSchema: { path: z.string() },
    },
    guard(async ({ path }: { path: string }) => {
      const session = await join(path);
      const threads = new CommentStore(session.doc).list();
      if (threads.length === 0) return ok("No comments.");
      return ok(
        threads
          .map(
            (t) =>
              `[${t.resolved ? "resolved" : "open"}${t.orphaned ? ", orphaned" : ""}] ${t.authorName} on ${JSON.stringify(t.quote)}: ${t.body}`,
          )
          .join("\n"),
      );
    }),
  );

  server.registerTool(
    "add_comment",
    {
      title: "Add a comment",
      description:
        "Attach a comment to an exact string in a document. Use this to raise a question " +
        "instead of editing when the right change is not obvious.",
      inputSchema: { path: z.string(), quote: z.string(), body: z.string() },
    },
    guard(async ({ path, quote, body }: { path: string; quote: string; body: string }) => {
      const session = await join(path);
      const at = session.text.toString().indexOf(quote);
      if (at === -1) return fail(`quote not found in ${path}`);
      new CommentStore(session.doc).add({
        text: session.text,
        from: at,
        to: at + quote.length,
        body,
        authorId: author.id,
        authorName: author.name,
      });
      await session.settle();
      return ok(`Comment added to ${path}.`);
    }),
  );

  server.registerTool(
    "create_document",
    {
      title: "Create a document",
      description:
        "Create a new Markdown document in the vault. Use this deliberately: every other " +
        "tool refuses an unknown path rather than creating one by accident.",
      inputSchema: {
        path: z.string().describe("Vault-relative path ending in .md"),
        content: z.string().optional(),
      },
    },
    guard(async ({ path, content }: { path: string; content?: string | undefined }) => {
      if (!/\.(md|markdown)$/i.test(path)) return fail("Document paths must end in .md");
      const files = await listFiles();
      if (files.includes(path)) return fail(`${path} already exists`);

      const session = await join(path, false);
      insertAttributed(session.text, 0, content ?? `# ${path.replace(/\.md$/i, "")}\n\n`, author);
      await session.settle();
      return ok(`Created ${path}.`);
    }),
  );


  server.registerTool(
    "document_provenance",
    {
      title: "Who wrote this document",
      description:
        "Report how much of a document each human and agent actually wrote, counted from " +
        "marks laid down at write time rather than guessed from the prose.",
      inputSchema: { path: z.string() },
    },
    guard(async ({ path }: { path: string }) => {
      const session = await join(path);
      const summary = summarise(session.doc, session.text, knownAuthors(session.doc) as never);
      if (summary.totalChars === 0) return ok("Document is empty.");
      const lines = summary.byAuthor.map(
        (a) => `  ${(a.share * 100).toFixed(1).padStart(5)}%  ${a.name} (${a.kind}, ${a.chars} chars)`,
      );
      return ok(
        `${path}\n  human ${(summary.humanShare * 100).toFixed(1)}%  agent ${(summary.agentShare * 100).toFixed(1)}%  unattributed ${(summary.unattributedShare * 100).toFixed(1)}%\n${lines.join("\n")}`,
      );
    }),
  );

  server.registerTool(
    "why_does_this_exist",
    {
      title: "Explain a passage's origin",
      description:
        "Given an exact quote, report which author and which run produced it, including the " +
        "instruction that caused it when one was recorded.",
      inputSchema: { path: z.string(), quote: z.string() },
    },
    guard(async ({ path, quote }: { path: string; quote: string }) => {
      const session = await join(path);
      const at = session.text.toString().indexOf(quote);
      if (at === -1) return fail(`quote not found in ${path}`);

      const found = runAt(session.doc, session.text, at);
      if (!found?.run) return ok("No recorded origin: written before provenance, or by hand.");
      const { run } = found;
      return ok(
        [
          `author: ${run.authorId}`,
          `model:  ${run.model ?? "(not recorded)"}`,
          `tool:   ${run.tool ?? "(not recorded)"}`,
          `when:   ${new Date(run.startedAt).toISOString()}`,
          `why:    ${run.prompt ?? "(no reason recorded)"}`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "get_agent_policy",
    {
      title: "Read this document's agent policy",
      description:
        "Report the leash on agents for a document: edit mode, insert and delete budgets, " +
        "and any sections locked against agent edits. These are enforced by the server, " +
        "so an agent cannot exceed them by ignoring this.",
      inputSchema: { path: z.string() },
    },
    guard(async ({ path }: { path: string }) => {
      const session = await join(path);
      const policy = readPolicy(session.doc);
      const headings = sections(session.text.toString()).map((s) => s.heading);
      return ok(
        [
          `mode:           ${policy.mode}`,
          `insert budget:  ${policy.maxInserts} characters per session`,
          `delete budget:  ${policy.maxDeletes} characters per session`,
          `locked:         ${policy.lockedSections.join(", ") || "(none)"}`,
          `sections here:  ${headings.join(", ") || "(none)"}`,
        ].join("\n"),
      );
    }),
  );

  server.registerTool(
    "set_agent_policy",
    {
      title: "Set this document's agent policy",
      description:
        "Constrain what agents may do to this document. Use it to lock sections before " +
        "handing a document to another agent, or to drop a document to propose-only.",
      inputSchema: {
        path: z.string(),
        mode: z.enum(["edit", "propose", "read-only"]).optional(),
        max_inserts: z.number().optional(),
        max_deletes: z.number().optional(),
        locked_sections: z.array(z.string()).optional(),
      },
    },
    guard(
      async ({
        path,
        mode,
        max_inserts,
        max_deletes,
        locked_sections,
      }: {
        path: string;
        mode?: "edit" | "propose" | "read-only" | undefined;
        max_inserts?: number | undefined;
        max_deletes?: number | undefined;
        locked_sections?: string[] | undefined;
      }) => {
        const session = await join(path);
        const next = writePolicy(session.doc, {
          ...(mode ? { mode } : {}),
          ...(max_inserts !== undefined ? { maxInserts: max_inserts } : {}),
          ...(max_deletes !== undefined ? { maxDeletes: max_deletes } : {}),
          ...(locked_sections ? { lockedSections: locked_sections } : {}),
        });
        await session.settle();
        return ok(`Policy for ${path}: ${next.mode}, +${next.maxInserts}/-${next.maxDeletes}, locked: ${next.lockedSections.join(", ") || "none"}`);
      },
    ),
  );

  server.registerTool(
    "list_assignments",
    {
      title: "List comments assigned to me",
      description:
        "Comment threads a human has assigned to an agent. Work through these and reply " +
        "with a suggestion rather than editing directly.",
      inputSchema: { path: z.string().optional() },
    },
    guard(async ({ path }: { path?: string | undefined }) => {
      const paths = path ? [path] : await listFiles();
      const out: string[] = [];
      for (const p of paths) {
        const session = await join(p);
        for (const thread of new CommentStore(session.doc).list()) {
          if (!thread.assignedTo || thread.resolved) continue;
          out.push(`${p} :: ${thread.id} :: on ${JSON.stringify(thread.quote)} :: ${thread.body}`);
        }
      }
      return ok(out.length ? out.join("\n") : "Nothing assigned.");
    }),
  );

  server.registerTool(
    "answer_assignment",
    {
      title: "Answer an assigned comment",
      description:
        "Respond to an assigned comment by proposing a replacement for the text it is " +
        "anchored to. The proposal appears beside the thread for a human to accept.",
      inputSchema: {
        path: z.string(),
        thread_id: z.string(),
        new_text: z.string(),
        note: z.string().optional(),
      },
    },
    guard(
      async ({
        path,
        thread_id,
        new_text,
        note,
      }: { path: string; thread_id: string; new_text: string; note?: string | undefined }) => {
        const session = await join(path);
        const comments = new CommentStore(session.doc);
        const thread = comments.list().find((t) => t.id === thread_id);
        if (!thread) return fail(`No comment ${thread_id} in ${path}`);
        if (!thread.range) return fail("That comment's anchor text has been deleted.");

        const runId = session.beginRun("answer_assignment", note ?? thread.body, model);
        const suggestionId = `s_${Date.now().toString(36)}`;
        proposeDelete(session.text, thread.range.from, thread.range.to, author, suggestionId);
        insertAttributed(session.text, thread.range.to, new_text, author, {
          suggestion: suggestionId,
          run: runId,
        });
        comments.reply(thread_id, note ?? "Proposed a change.", author.id, author.name);
        await session.settle();
        return ok(`Proposed ${suggestionId} against ${thread_id}, and replied on the thread.`);
      },
    ),
  );

  server.registerTool(
    "vault_overview",
    {
      title: "Read the whole vault",
      description:
        "Return every document's text at once, for checks that only make sense across " +
        "documents -- contradictions, drift between a spec and a runbook, duplicated " +
        "guidance. Report findings with add_comment on the documents involved.",
      inputSchema: { max_chars: z.number().optional() },
    },
    guard(async ({ max_chars }: { max_chars?: number | undefined }) => {
      const budget = max_chars ?? 120_000;
      const files = await listFiles();
      const parts: string[] = [];
      let used = 0;
      for (const file of files) {
        const session = await join(file);
        const body = committedText(session.text);
        const chunk = `\n===== ${file} =====\n${body}`;
        if (used + chunk.length > budget) {
          parts.push(`\n(truncated: ${files.length - parts.length} documents not shown)`);
          break;
        }
        parts.push(chunk);
        used += chunk.length;
      }
      return ok(parts.join(""));
    }),
  );

  server.registerTool(
    "compare_versions",
    {
      title: "Compare a document against text",
      description:
        "Return the current document alongside text you supply, so you can describe what " +
        "changed in meaning rather than in lines -- a weakened claim, a hedge removed, " +
        "'should' becoming 'must'. Report the reading back as comments.",
      inputSchema: { path: z.string(), other: z.string(), label: z.string().optional() },
    },
    guard(async ({ path, other, label }: { path: string; other: string; label?: string | undefined }) => {
      const session = await join(path);
      return ok(
        `===== ${path} (current) =====\n${committedText(session.text)}\n\n===== ${label ?? "other"} =====\n${other}`,
      );
    }),
  );

  server.registerTool(
    "search_vault",
    {
      title: "Search the vault",
      description: "Full-text search across every document in the vault.",
      inputSchema: { query: z.string(), limit: z.number().optional() },
    },
    guard(async ({ query, limit }: { query: string; limit?: number | undefined }) => {
      const url = new URL("/api/search", options.serverUrl);
      url.searchParams.set("q", query);
      if (limit) url.searchParams.set("limit", String(limit));
      const res = await fetch(url);
      const body = (await res.json()) as { results: Array<{ path: string; line: number; text: string }> };
      if (body.results.length === 0) return ok("No matches.");
      return ok(body.results.map((r) => `${r.path}:${r.line}: ${r.text}`).join("\n"));
    }),
  );

  return server;
}

export async function runStdio(options: McpOptions): Promise<void> {
  const server = await createQuireMcpServer(options);
  await server.connect(new StdioServerTransport());
}
