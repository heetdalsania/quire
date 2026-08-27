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
import { type Registry, type RegistryEntry, renderGallery } from "./discover.js";
import { onColorSchemeChange, renderPreview } from "./preview.js";
import { SyncProvider } from "./provider.js";
import {
  CommentStore,
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
const modeVaultBtn = $<HTMLButtonElement>("#mode-vault");
const modeDiscoverBtn = $<HTMLButtonElement>("#mode-discover");
const categoriesEl = $("#categories");
const galleryEl = $("#gallery");
const discoverEl = $("#discover");
const discoverNoteEl = $("#discover-note");
const cmtCount = $("#cmt-count");

let view: EditorView | null = null;
let provider: SyncProvider | null = null;
let persistence: IndexeddbPersistence | null = null;
let doc: Y.Doc | null = null;
let ytext: Y.Text | null = null;
let comments: CommentStore | null = null;
let current: string | null = null;
let allFiles: string[] = [];
let links: { backlinks: Record<string, string[]> } = { backlinks: {} };
/** Server lineage. Local offline state is scoped to it -- see openPersistence. */
let epoch = "";
let gitAvailable = false;
let registry: Registry = { available: false, categories: [], entries: [] };
let mode: "vault" | "discover" = "vault";
let activeCategory: string | null = null;

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
  backlinksPanel.dataset.empty = String(incoming.length === 0);
  backlinksPanel.hidden = incoming.length === 0 || mode === "discover";
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
    if (mode === "discover") return paintGallery();
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

// ---------------------------------------------------------------- discover

function toast(message: string, bad = false): void {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = bad ? "toast bad" : "toast";
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), bad ? 6000 : 3600);
}

function renderCategories(): void {
  const all = document.createElement("button");
  all.textContent = "Everything";
  const count = document.createElement("small");
  count.textContent = `${registry.entries.length} documents`;
  all.append(count);
  if (activeCategory === null) all.setAttribute("aria-current", "true");
  all.onclick = () => { activeCategory = null; renderCategories(); paintGallery(); };

  categoriesEl.replaceChildren(
    all,
    ...registry.categories.map((cat) => {
      const button = document.createElement("button");
      button.textContent = cat.label;
      const blurb = document.createElement("small");
      blurb.textContent = cat.blurb;
      button.append(blurb);
      if (activeCategory === cat.id) button.setAttribute("aria-current", "true");
      button.onclick = () => { activeCategory = cat.id; renderCategories(); paintGallery(); };
      return button;
    }),
  );
}

function paintGallery(): void {
  renderGallery(galleryEl, registry, { category: activeCategory, query: searchEl.value }, {
    installed: (entry) => allFiles.includes(entry.installAs),
    onPreview: (entry) => void previewEntry(entry),
    onInstall: (entry) => void installEntry(entry),
  });
}

/** Read a registry document before committing to it. Fetched by the server, not the page. */
async function previewEntry(entry: RegistryEntry): Promise<void> {
  toast(`Fetching ${entry.title} from ${entry.repo}…`);
  try {
    const { content, error } = await api<{ content?: string; error?: string }>(
      `/api/registry/preview?id=${encodeURIComponent(entry.id)}`,
    );
    if (!content) throw new Error(error ?? "No content returned");
    document.querySelector(".toast")?.remove();
    setMode("vault");
    pathEl.textContent = `${entry.repo} · preview (not saved)`;
    view?.destroy();
    view = null;
    await renderPreview(previewEl, content.slice(0, 200_000), {
      resolveLink: () => null,
      onNavigate: () => {},
    });
    editorEl.replaceChildren(
      Object.assign(document.createElement("pre"), {
        className: "preview-source",
        textContent: content.slice(0, 200_000),
      }),
    );
  } catch (error) {
    toast((error as Error).message, true);
  }
}

async function installEntry(entry: RegistryEntry): Promise<void> {
  toast(`Adding ${entry.title}…`);
  try {
    const result = await api<{ path?: string; error?: string }>(
      `/api/registry/install?id=${encodeURIComponent(entry.id)}`,
      { method: "POST" },
    );
    if (!result.path) throw new Error(result.error ?? "Install failed");
    toast(`Saved to ${result.path}`);
    paintGallery();
    setMode("vault");
    await open(result.path);
  } catch (error) {
    toast((error as Error).message, true);
  }
}

function setMode(next: "vault" | "discover"): void {
  mode = next;
  document.body.classList.toggle("discovering", next === "discover");
  discoverEl.hidden = next !== "discover";
  filesEl.hidden = next === "discover";
  categoriesEl.hidden = next !== "discover";
  backlinksPanel.hidden = next === "discover" || backlinksPanel.dataset.empty === "true";
  modeVaultBtn.setAttribute("aria-selected", String(next === "vault"));
  modeDiscoverBtn.setAttribute("aria-selected", String(next === "discover"));
  searchEl.placeholder = next === "discover" ? "Search Discover" : "Search the vault";
  if (next === "discover") paintGallery();
}

modeVaultBtn.onclick = () => setMode("vault");
modeDiscoverBtn.onclick = () => {
  if (!registry.available) return toast("Discover is disabled (started with --no-discover).", true);
  setMode("discover");
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
  comments = new CommentStore(doc);

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
  comments.yarray.observeDeep(renderRail);

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

  // Exposed for automated walkthroughs and end-to-end tests; harmless in normal use.
  (window as unknown as { __quireView?: EditorView }).__quireView = view;

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
    comments?.add({ text: ytext!, from, to, body, authorId: me.id, authorName: me.name });
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

  registry = await api<Registry>("/api/registry").catch(() => registry);
  modeDiscoverBtn.hidden = !registry.available;
  if (registry.available) {
    discoverNoteEl.textContent = registry.note ?? "";
    renderCategories();
  }

  renderFiles(allFiles);
  await refreshLinks().catch(() => {});

  if (allFiles[0]) await open(allFiles[0]);
  else pathEl.textContent = "No Markdown files in this folder yet.";

  // Push, not poll: a file an agent or the registry just created should appear at once.
  const events = new EventSource("/api/events");
  events.onmessage = (message) => {
    const data = JSON.parse(message.data) as { kind: string; files: string[] };
    if (data.kind !== "files") return;
    const changed = data.files.join("\u0000") !== allFiles.join("\u0000");
    if (!changed) return;
    allFiles = data.files;
    if (mode === "discover") paintGallery();
    else if (!searchEl.value.trim()) renderFiles(allFiles);
    void refreshLinks().catch(() => {});
  };

  onColorSchemeChange(() => void paintPreview());
}

await boot();
