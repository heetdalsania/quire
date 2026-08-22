import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import {
  attributionExtension,
  attributionTheme,
  authorRegistry,
  isAttributionVisible,
  setAttributionVisible,
} from "./decorations.js";
import { renderPreview } from "./preview.js";
import { SyncProvider } from "./provider.js";
import {
  Comments,
  acceptSuggestion,
  authorsPresent,
  committedTextOf,
  readAuthors,
  registerLocalAuthor,
  listSuggestions,
  rejectSuggestion,
  revertAuthor,
  scrollTo,
} from "./rail.js";

const PALETTE = ["#3b5bdb", "#c2255c", "#2f9e44", "#e8590c", "#7048e8", "#0c8599"];
const ANIMALS = ["Otter", "Heron", "Falcon", "Marten", "Ibex", "Lynx", "Plover", "Vole"];
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;

// Identity is generated in the browser. No account, no signup, nothing sent anywhere.
const me = { id: `u_${Math.random().toString(36).slice(2, 10)}`, name: pick(ANIMALS), color: pick(PALETTE), kind: "human" as const };

const $ = <T extends HTMLElement>(sel: string): T => document.querySelector<T>(sel)!;
const filesEl = $("#files");
const statusEl = $("#status");
const pathEl = $("#docpath");
const presenceEl = $("#presence");
const editorEl = $("#editor");
const previewEl = $("#preview");
const suggestionsEl = $("#suggestions");
const commentsEl = $("#comments");
const agentsEl = $("#agents");
const agentsSection = $("#agents-section");
const backlinksEl = $("#backlinks");
const backlinksPanel = $("#backlinks-panel");
const searchEl = $<HTMLInputElement>("#search");
const commentBtn = $<HTMLButtonElement>("#comment-btn");
const attrBtn = $<HTMLButtonElement>("#attr-btn");
const snapshotBtn = $<HTMLButtonElement>("#snapshot-btn");
const sugCount = $("#sug-count");
const cmtCount = $("#cmt-count");

let view: EditorView | null = null;
let provider: SyncProvider | null = null;
let doc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let comments: Comments | null = null;
let current: string | null = null;
let allFiles: string[] = [];
let links: { backlinks: Record<string, string[]> } = { backlinks: {} };

const api = async <T,>(path: string, init?: RequestInit): Promise<T> =>
  (await fetch(path, init)).json() as Promise<T>;

// ---------------------------------------------------------------- sidebar

function renderFiles(files: string[], hits?: Map<string, string>): void {
  filesEl.replaceChildren(
    ...files.map((path) => {
      const button = document.createElement("button");
      button.title = path;
      const name = document.createElement("span");
      name.textContent = path;
      button.append(name);
      if (hits?.has(path)) {
        const hit = document.createElement("em");
        hit.textContent = hits.get(path)!;
        button.append(hit);
      }
      if (path === current) button.setAttribute("aria-current", "true");
      button.onclick = () => void open(path);
      return button;
    }),
  );
}

function renderBacklinks(): void {
  const incoming = current ? (links.backlinks[current] ?? []) : [];
  backlinksPanel.hidden = incoming.length === 0;
  backlinksEl.replaceChildren(
    ...incoming.map((path) => {
      const a = document.createElement("button");
      a.className = "link";
      a.textContent = path;
      a.onclick = () => void open(path);
      return a;
    }),
  );
}

let searchTimer: number | undefined;
searchEl.oninput = () => {
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(async () => {
    const q = searchEl.value.trim();
    if (!q) return renderFiles(allFiles);
    const { results } = await api<{ results: Array<{ path: string; line: number; text: string }> }>(
      `/api/search?q=${encodeURIComponent(q)}`,
    );
    const hits = new Map<string, string>();
    for (const r of results) if (!hits.has(r.path)) hits.set(r.path, r.text.trim().slice(0, 80));
    renderFiles([...hits.keys()], hits);
  }, 160);
};

// ---------------------------------------------------------------- presence

/** Merge durable author identities from the document into the render registry. */
function syncAuthors(): void {
  if (!doc) return;
  for (const [id, meta] of Object.entries(readAuthors(doc))) authorRegistry.set(id, meta);
}

function renderPresence(): void {
  if (!provider) return;
  syncAuthors();
  const seen = new Map<number, { name: string; color: string; kind?: string }>();
  for (const [clientId, state] of provider.awareness.getStates()) {
    const user = (state as { user?: { name: string; color: string; kind?: string } }).user;
    if (!user) continue;
    seen.set(clientId, user);
    authorRegistry.set(`u_${clientId}`, { name: user.name, color: user.color, kind: (user.kind as "human" | "agent") ?? "human" });
    if (user.kind === "agent") {
      authorRegistry.set(`agent-${user.name.toLowerCase().replace(/\W+/g, "-")}`, {
        name: user.name, color: user.color, kind: "agent",
      });
    }
  }
  authorRegistry.set(me.id, { name: me.name, color: me.color, kind: "human" });

  presenceEl.replaceChildren(
    ...[...seen.values()].map((user) => {
      const el = document.createElement("div");
      el.className = user.kind === "agent" ? "avatar agent" : "avatar";
      el.style.background = user.color;
      el.textContent = user.kind === "agent" ? "AI" : user.name.slice(0, 1);
      el.title = user.kind === "agent" ? `${user.name} (agent)` : user.name;
      return el;
    }),
  );
}

// ---------------------------------------------------------------- right rail

function renderRail(): void {
  if (!ytext || !view) return;
  syncAuthors();

  const suggestions = listSuggestions(ytext);
  sugCount.textContent = String(suggestions.length);
  suggestionsEl.classList.toggle("empty", suggestions.length === 0);
  if (suggestions.length === 0) {
    suggestionsEl.textContent = "Nothing pending.";
  } else {
    suggestionsEl.replaceChildren(
      ...suggestions.map((s) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.setProperty("--who", s.color);
        const who = document.createElement("div");
        who.className = "who";
        who.textContent = `${s.authorName} proposes`;
        card.append(who);
        if (s.removed) {
          const del = document.createElement("del");
          del.textContent = s.removed;
          card.append(del);
        }
        if (s.inserted) {
          const ins = document.createElement("ins");
          ins.textContent = s.inserted;
          card.append(ins);
        }
        const actions = document.createElement("div");
        actions.className = "actions";
        const accept = document.createElement("button");
        accept.textContent = "Accept";
        accept.className = "primary";
        accept.onclick = () => { acceptSuggestion(ytext!, s.id); renderRail(); };
        const reject = document.createElement("button");
        reject.textContent = "Reject";
        reject.onclick = () => { rejectSuggestion(ytext!, s.id); renderRail(); };
        actions.append(accept, reject);
        card.append(actions);
        return card;
      }),
    );
  }

  const threads = comments?.list() ?? [];
  cmtCount.textContent = String(threads.length);
  commentsEl.classList.toggle("empty", threads.length === 0);
  if (threads.length === 0) {
    commentsEl.textContent = "No comments yet. Select text and press Comment.";
  } else {
    commentsEl.replaceChildren(
      ...threads.map((t) => {
        const card = document.createElement("div");
        card.className = `card${t.resolved ? " resolved" : ""}${t.orphaned ? " orphaned" : ""}`;
        const who = document.createElement("div");
        who.className = "who";
        who.textContent = t.orphaned ? `${t.authorName} · anchor deleted` : t.authorName;
        const quote = document.createElement("blockquote");
        quote.textContent = t.quote;
        const body = document.createElement("p");
        body.textContent = t.body;
        card.append(who, quote, body);

        const actions = document.createElement("div");
        actions.className = "actions";
        if (t.range) {
          const go = document.createElement("button");
          go.textContent = "Show";
          go.onclick = () => scrollTo(view!, t.range!.from, t.range!.to);
          actions.append(go);
        }
        const resolve = document.createElement("button");
        resolve.textContent = t.resolved ? "Reopen" : "Resolve";
        resolve.onclick = () => { comments!.setResolved(t.id, !t.resolved); renderRail(); };
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.onclick = () => { comments!.remove(t.id); renderRail(); };
        actions.append(resolve, del);
        card.append(actions);
        return card;
      }),
    );
  }

  const agents = authorsPresent(ytext)
    .map((id) => ({ id, meta: authorRegistry.get(id) }))
    .filter((a) => a.meta?.kind === "agent");
  agentsSection.hidden = agents.length === 0;
  agentsEl.replaceChildren(
    ...agents.map(({ id, meta }) => {
      const button = document.createElement("button");
      button.className = "revert";
      button.textContent = `Revert ${meta!.name}'s edits`;
      button.title = "Removes only this agent's spans, leaving everyone else's text alone";
      button.onclick = () => {
        const removed = revertAuthor(ytext!, id);
        if (removed) renderRail();
      };
      return button;
    }),
  );
}

// ---------------------------------------------------------------- document

async function refreshLinks(): Promise<void> {
  links = await api<{ backlinks: Record<string, string[]> }>("/api/links");
  renderBacklinks();
}

async function paintPreview(): Promise<void> {
  if (!view || !ytext) return;
  // Render the committed projection, so the preview always matches the file on disk
  // rather than splicing un-accepted suggestions into the prose.
  await renderPreview(previewEl, committedTextOf(ytext), {
    resolveLink: (target) => {
      const wanted = target.toLowerCase().replace(/\.md$/, "");
      return (
        allFiles.find((f) => f.toLowerCase() === `${wanted}.md` || f.toLowerCase() === wanted) ??
        allFiles.find((f) => (f.split("/").pop() ?? "").toLowerCase().replace(/\.md$/, "") === wanted) ??
        null
      );
    },
    onNavigate: (path) => void open(path),
  });
}

async function open(path: string): Promise<void> {
  view?.destroy();
  provider?.destroy();
  doc?.destroy();

  current = path;
  doc = new Y.Doc();
  ytext = doc.getText("content");
  comments = new Comments(doc);

  const url = new URL(`/sync?doc=${encodeURIComponent(path)}`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  provider = new SyncProvider(url.toString(), doc, (connected) => {
    statusEl.textContent = connected ? "live" : "offline";
    statusEl.classList.toggle("live", connected);
  });
  registerLocalAuthor(doc, me.id, me.name, me.color);
  provider.awareness.setLocalStateField("user", { name: me.name, color: me.color, kind: me.kind });
  provider.awareness.on("change", () => { renderPresence(); renderRail(); });
  comments.observe(renderRail);

  view = new EditorView({
    parent: editorEl,
    state: EditorState.create({
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        yCollab(ytext, provider.awareness),
        attributionTheme,
        attributionExtension(ytext, renderRail),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) void paintPreview();
          if (u.selectionSet || u.docChanged) {
            const sel = u.state.selection.main;
            commentBtn.disabled = sel.empty;
          }
        }),
      ],
    }),
  });

  pathEl.textContent = path;
  await paintPreview();
  renderPresence();
  renderRail();
  renderFiles(allFiles);
  renderBacklinks();
}

// ---------------------------------------------------------------- toolbar

commentBtn.onclick = () => {
  if (!view || !ytext || !comments) return;
  const sel = view.state.selection.main;
  if (sel.empty) return;
  const body = window.prompt("Comment");
  if (!body?.trim()) return;
  comments.add(ytext, sel.from, sel.to, body.trim(), me.id, me.name);
  renderRail();
};

attrBtn.onclick = () => {
  const next = !isAttributionVisible();
  setAttributionVisible(view, next);
  attrBtn.setAttribute("aria-pressed", String(next));
};

snapshotBtn.onclick = async () => {
  snapshotBtn.disabled = true;
  const { sha } = await api<{ sha: string | null }>("/api/snapshot", { method: "POST" });
  snapshotBtn.textContent = sha ? `Saved ${sha.slice(0, 7)}` : "No changes";
  setTimeout(() => { snapshotBtn.textContent = "Snapshot"; snapshotBtn.disabled = false; }, 1800);
};

// ---------------------------------------------------------------- boot

allFiles = (await api<{ files: string[] }>("/api/files")).files;
renderFiles(allFiles);
await refreshLinks();
if (allFiles[0]) await open(allFiles[0]);
else pathEl.textContent = "no markdown files in this folder yet";
setInterval(() => void refreshLinks(), 15_000);
