import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type Author,
  CommentStore,
  committedText,
  insertAttributed,
  pendingSuggestions,
  proposeDelete,
  spans,
} from "@quire/bridge";
import { AgentSession } from "./session.js";

export interface McpOptions {
  /** Base URL of the running Quire server. */
  serverUrl: string;
  agentName: string;
  agentColor: string;
}

const ok = (text: string) => ({ content: [{ type: "text" as const, text }] });
const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });

export async function createQuireMcpServer(options: McpOptions): Promise<McpServer> {
  const author: Author = {
    id: `agent-${options.agentName.toLowerCase().replace(/\W+/g, "-")}`,
    name: options.agentName,
    color: options.agentColor,
    kind: "agent",
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
      },
    },
    guard(async ({ path, old_text, new_text, suggest }: { path: string; old_text: string; new_text: string; suggest?: boolean | undefined }) => {
      const session = await join(path);
      const current = session.text.toString();

      const first = current.indexOf(old_text);
      if (first === -1) return fail(`old_text not found in ${path}`);
      if (current.indexOf(old_text, first + 1) !== -1) {
        return fail(`old_text occurs more than once in ${path}; include more context`);
      }

      const suggestionId = suggest ? `s_${Date.now().toString(36)}` : undefined;
      session.announce({ anchor: first, head: first + old_text.length });

      if (suggestionId) {
        // Show both sides: the removal is proposed, the replacement sits beside it.
        if (old_text.length > 0) {
          proposeDelete(session.text, first, first + old_text.length, author, suggestionId);
        }
        insertAttributed(session.text, first + old_text.length, new_text, author, {
          suggestion: suggestionId,
        });
      } else {
        session.doc.transact(() => {
          session.text.delete(first, old_text.length);
        }, `author:${author.id}`);
        insertAttributed(session.text, first, new_text, author);
      }

      await session.settle();
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
