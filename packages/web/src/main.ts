import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { quireEditorTheme, quireHighlight } from "./theme.js";
import { IndexeddbPersistence } from "y-indexeddb";
import * as Y from "yjs";
import {
  attributionExtension,
  attributionTheme,
  authorRegistry,
  isAttributionVisible,
  setAttributionVisible,
} from "./decorations.js";
import { onColorSchemeChange, renderPreview } from "./preview.js";
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
const statusTextEl = $(".status-text");
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
let persistence: IndexeddbPersistence | null = null;
let doc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let comments: Comments | null = null;
let current: string | null = null;
let allFiles: string[] = [];
let links: { backlinks: Record<string, string[]> } = { backlinks: {} };
/** Server lineage. Local offline state is scoped to it -- see openPersistence. */
let epoch = "";
let gitAvailable = false;

/**
 * Offline state is namespaced by server epoch.
 *
 * Persisting a document and then merging it into a *restarted* server would recreate the
 * duplication bug the epoch exists to prevent: the new process re-seeds from disk with a
 * fresh clientID, and Yjs would concatenate rather than recognise the identical text. So
 * stores from other epochs are discarded at boot, and unsynced offline edits from a
 * previous server lifetime are dropped rather than doubled.
 */
async function purgeStaleOfflineStores(): Promise<void> {
  try {
    const dbs = await indexedDB.databases?.();
    for (const db of dbs ?? []) {
      if (db.name?.startsWith("quire:") && !db.name.startsWith(`quire:${epoch}:`)) {
        indexedDB.deleteDatabase(db.name);
      }
    }
  } catch {
    // Firefox lacks indexedDB.databases(); stale stores are simply never reused.
  }
}

let offline = false;

/** Fetch JSON, surfacing server trouble in the status pill instead of throwing into the void. */
async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error(`${path} responded ${res.status}`);
  return (await res.json()) as T;
}

function setStatus(text: string, live: boolean): void {
  statusTextEl.textContent = text;
  statusEl.classList.toggle("live", live);
}

// ---------------------------------------------------------------- sidebar

function renderFiles(files: string[], hits?: Map<string, string>): void {
  filesEl.replaceChildren(
    ...files.map((path) => {
      const button = document.createElement("button");
      button.title = path;
      const name = document.createElement("span");
      name.className = "name";
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
    ).catch(() => ({ results: [] as Array<{ path: string; line: number; text: string }> }));
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
  sugCount.classList.toggle("hot", suggestions.length > 0);
  if (suggestions.length === 0) {
    suggestionsEl.innerHTML =
      '<p class="empty-note">Nothing awaiting review. Agent edits made with <code>suggest</code> appear here before they reach the file.</p>';
  } else {
    suggestionsEl.replaceChildren(
      ...suggestions.map((s) => {
        const card = document.createElement("div");
        card.className = "card";
        card.style.setProperty("--who", s.color);
        const who = document.createElement("div");
        who.className = "who";
        who.append(document.createTextNode(`${s.authorName} proposes`));
        if (s.authorId && authorRegistry.get(s.authorId)?.kind === "agent") {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = "agent";
          who.append(chip);
        }
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
  if (threads.length === 0) {
    commentsEl.innerHTML = '<p class="empty-note">No comments yet. Select some text and press Comment.</p>';
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
  if (offline) return;
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
  void persistence?.destroy();
  doc?.destroy();

  current = path;
  doc = new Y.Doc();
  ytext = doc.getText("content");
  comments = new Comments(doc);

  const url = new URL(`/sync?doc=${encodeURIComponent(path)}`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  // Local-first: the document is readable and editable from IndexedDB before -- and
  // without -- a server round trip.
  persistence = new IndexeddbPersistence(`quire:${epoch}:${path}`, doc);

  provider = new SyncProvider(url.toString(), doc, (connected) => {
    offline = !connected;
    setStatus(connected ? "live" : "offline", connected);
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
        quireEditorTheme,
        quireHighlight,
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

/**
 * Inline comment composer.
 *
 * A native prompt() blocks the page and cannot be styled, which is a poor fit for a tool
 * whose whole premise is that other people are editing at the same time. The composer
 * lives in the rail beside the thread it will become.
 */
function openComposer(from: number, to: number): void {
  if (!ytext) return;
  document.querySelector(".composer")?.remove();

  const card = document.createElement("form");
  card.className = "card composer";
  card.style.setProperty("--who", me.color);

  const who = document.createElement("div");
  who.className = "who";
  who.textContent = `${me.name} · new comment`;

  const quote = document.createElement("blockquote");
  quote.textContent = ytext.toString().slice(from, to).slice(0, 180);

  const field = document.createElement("textarea");
  field.rows = 3;
  field.placeholder = "What needs saying?";

  const actions = document.createElement("div");
  actions.className = "actions";
  const save = document.createElement("button");
  save.type = "submit";
  save.className = "primary";
  save.textContent = "Comment";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "Cancel";
  cancel.onclick = () => { card.remove(); view?.focus(); };
  actions.append(save, cancel);

  card.append(who, quote, field, actions);
  card.onsubmit = (event) => {
    event.preventDefault();
    const body = field.value.trim();
    if (!body) return;
    comments?.add(ytext!, from, to, body, me.id, me.name);
    card.remove();
    renderRail();
    view?.focus();
  };
  // Cmd/Ctrl+Enter to submit, Escape to abandon.
  field.onkeydown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); cancel.click(); }
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); save.click(); }
  };

  commentsEl.prepend(card);
  field.focus();
}

commentBtn.onclick = () => {
  if (!view) return;
  const sel = view.state.selection.main;
  if (!sel.empty) openComposer(sel.from, sel.to);
};

attrBtn.onclick = () => {
  const next = !isAttributionVisible();
  setAttributionVisible(view, next);
  attrBtn.setAttribute("aria-pressed", String(next));
};

const snapshotLabel = $("#snapshot-label");
snapshotBtn.onclick = async () => {
  snapshotBtn.disabled = true;
  const { sha } = await api<{ sha: string | null }>("/api/snapshot", { method: "POST" });
  snapshotLabel.textContent = sha ? sha.slice(0, 7) : "No changes";
  snapshotBtn.classList.toggle("done", Boolean(sha));
  setTimeout(() => {
    snapshotLabel.textContent = "Snapshot";
    snapshotBtn.classList.remove("done");
    snapshotBtn.disabled = false;
  }, 2000);
};

// ---------------------------------------------------------------- boot

// Cmd/Ctrl+K focuses search, Cmd/Ctrl+Shift+A toggles authorship, Escape leaves search.
window.addEventListener("keydown", (event) => {
  const mod = event.metaKey || event.ctrlKey;
  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault();
    searchEl.focus();
    searchEl.select();
  } else if (mod && event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    attrBtn.click();
  } else if (event.key === "Escape" && document.activeElement === searchEl) {
    searchEl.value = "";
    renderFiles(allFiles);
    view?.focus();
  }
});

async function boot(): Promise<void> {
  try {
    const info = await api<{ files: string[]; epoch: string; git: boolean }>("/api/files");
    allFiles = info.files;
    epoch = info.epoch;
    gitAvailable = info.git;
  } catch {
    setStatus("server unreachable", false);
    pathEl.textContent = "Cannot reach the Quire server. Is it still running?";
    return;
  }

  await purgeStaleOfflineStores();
  snapshotBtn.hidden = !gitAvailable;

  renderFiles(allFiles);
  await refreshLinks().catch(() => {});

  if (allFiles[0]) await open(allFiles[0]);
  else pathEl.textContent = "No Markdown files in this folder yet.";

  onColorSchemeChange(() => void paintPreview());
  setInterval(() => void refreshLinks().catch(() => {}), 15_000);
}

await boot();
