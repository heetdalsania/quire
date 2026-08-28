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
import { type DisplaySettings, applySettings, loadSettings, saveSettings } from "./display.js";
import { THEMES, applyTheme, resolveTheme } from "./themes.js";
import { type Registry, type RegistryEntry, renderGallery } from "./discover.js";
import {
  copyRichText,
  copyToClipboard,
  downloadHtml,
  downloadMarkdown,
  downloadText,
  printDocument,
} from "./export.js";
import { applyLayout, getLayout, loadLayout, togglePanel, wireResizer } from "./layout.js";
import { closeMenu, heading, hint, menuItem, openMenu, row, segmented, slider } from "./menus.js";
import { answerPeer, offerPeer, type PeerHandle } from "./peer.js";
import { configureSuggesting, isSuggesting, setSuggesting, suggestingExtension } from "./suggesting.js";
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
const suggestBtn = $<HTMLButtonElement>("#suggest-btn");
const shareBtn = $<HTMLButtonElement>("#share-btn");
const exportBtn = $<HTMLButtonElement>("#export-btn");
const displayBtn = $<HTMLButtonElement>("#display-btn");
const insightBtn = $<HTMLButtonElement>("#insight-btn");
const replayBar = $("#replay-bar");
const replayRange = $<HTMLInputElement>("#replay-range");
const replayLabel = $("#replay-label");
const splitEl = $("#split");
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
let githubSearchOn = false;
let display: DisplaySettings = loadSettings();
let execEnabled = false;
let historyEnabled = false;
/** Set when this session was opened through a share link that limits what we may do. */
let shareRole: "view" | "comment" | "edit" | null = null;
let peer: PeerHandle | null = null;
const driftByPath = new Map<string, string>();
let replayFrames: Array<{ at: number; byAuthor: Record<string, number>; totalChars: number }> = [];

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
      const drift = driftByPath.get(path);
      if (drift && drift !== "current") {
        const pill = document.createElement("span");
        pill.className = "drift-pill";
        pill.textContent = drift === "upstream-changed" ? "update" : drift === "diverged" ? "diverged" : "edited";
        pill.title = "Installed from Discover; upstream has moved on";
        name.append(pill);
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

  const githubCat = document.createElement("button");
  githubCat.textContent = "Search GitHub";
  const githubBlurb = document.createElement("small");
  githubBlurb.textContent = "Everything the index does not cover";
  githubCat.append(githubBlurb);
  if (activeCategory === "github") githubCat.setAttribute("aria-current", "true");
  githubCat.onclick = () => {
    activeCategory = "github";
    renderCategories();
    searchEl.focus();
    paintGallery();
  };

  categoriesEl.replaceChildren(
    all,
    ...(githubSearchOn ? [githubCat] : []),
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

interface GithubHit {
  id: string; title: string; byline: string; description: string;
  repo: string; branch: string; stars: number; license: string; updated: string; source: string;
}

/**
 * Live GitHub search, for everything the curated index does not cover.
 * Repository search works without a token, so this needs no account.
 */
async function searchGithubAndRender(query: string): Promise<void> {
  galleryEl.replaceChildren(Object.assign(document.createElement("p"), {
    className: "empty-note",
    textContent: `Searching GitHub for "${query}"…`,
  }));
  try {
    const res = await fetch(`/api/discover/search?q=${encodeURIComponent(query)}`);
    const body = (await res.json()) as { hits?: GithubHit[]; error?: string };
    if (body.error) throw new Error(body.error);
    const hits = body.hits ?? [];
    if (hits.length === 0) {
      galleryEl.replaceChildren(Object.assign(document.createElement("p"), {
        className: "empty-note",
        textContent: "No repositories matched. Try broader words.",
      }));
      return;
    }
    renderGallery(
      galleryEl,
      { available: true, categories: [], entries: hits.map((h) => ({ ...h, category: "github", installAs: "" })) },
      { category: null, query: "" },
      {
        installed: () => false,
        onPreview: (entry) => void browseRepo(entry as unknown as GithubHit),
        onInstall: (entry) => void browseRepo(entry as unknown as GithubHit),
      },
    );
  } catch (error) {
    galleryEl.replaceChildren(Object.assign(document.createElement("p"), {
      className: "empty-note",
      textContent: (error as Error).message,
    }));
  }
}

/** A repository is not a document, so pick which Markdown file to bring across. */
async function browseRepo(hit: GithubHit): Promise<void> {
  toast(`Listing Markdown in ${hit.repo}…`);
  try {
    const res = await fetch(
      `/api/discover/files?repo=${encodeURIComponent(hit.repo)}&branch=${encodeURIComponent(hit.branch)}`,
    );
    const body = (await res.json()) as { files?: Array<{ path: string; size: number }>; error?: string };
    if (body.error) throw new Error(body.error);
    const files = body.files ?? [];
    closeMenu();
    if (files.length === 0) return toast("No Markdown files at that repository's root.", true);

    openMenu(galleryEl, (panel) => {
      panel.append(heading(hit.repo));
      for (const file of files.slice(0, 14)) {
        panel.append(menuItem(file.path, `${Math.max(1, Math.round(file.size / 1024))} KB`, async () => {
          try {
            const params = new URLSearchParams({ repo: hit.repo, branch: hit.branch, path: file.path });
            const result = await api<{ path?: string; error?: string }>(
              `/api/discover/install?${params}`, { method: "POST" },
            );
            if (!result.path) throw new Error(result.error ?? "Install failed");
            toast(`Saved to ${result.path}`);
            setMode("vault");
            await open(result.path);
          } catch (error) {
            toast((error as Error).message, true);
          }
        }));
      }
      panel.append(hint("Files come straight from the repository. Quire records where each one came from."));
    });
  } catch (error) {
    toast((error as Error).message, true);
  }
}

function paintGallery(): void {
  const query = searchEl.value.trim();
  if (query.length >= 3 && githubSearchOn && activeCategory === "github") {
    void searchGithubAndRender(query);
    return;
  }
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


// ---------------------------------------------------------------- insight panel

interface ProvenanceSummary {
  totalChars: number;
  byAuthor: Array<{ authorId: string; name: string; kind: string; chars: number; share: number }>;
  humanShare: number;
  agentShare: number;
  unattributedShare: number;
}

const pct = (n: number): string => `${(n * 100).toFixed(n >= 0.995 || n === 0 ? 0 : 1)}%`;

/**
 * Provenance, read from marks laid down at write time.
 *
 * Every other tool answering "did a person write this?" is guessing from the prose.
 * Quire watched it being written, so this is a record rather than an estimate.
 */
function renderProvenance(panel: HTMLElement, summary: ProvenanceSummary): void {
  if (summary.totalChars === 0) {
    panel.append(hint("Nothing written yet."));
    return;
  }
  const headline = document.createElement("p");
  headline.className = "prov-headline";
  headline.innerHTML =
    `<strong>${pct(summary.humanShare)}</strong> human · ` +
    `<strong>${pct(summary.agentShare)}</strong> agent` +
    (summary.unattributedShare > 0 ? ` · ${pct(summary.unattributedShare)} unattributed` : "");
  panel.append(headline);

  const bar = document.createElement("div");
  bar.className = "prov-bar";
  for (const author of summary.byAuthor) {
    const seg = document.createElement("span");
    seg.style.width = `${author.share * 100}%`;
    seg.style.background = colourFor(author);
    seg.title = `${author.name} — ${pct(author.share)}`;
    bar.append(seg);
  }
  panel.append(bar);

  for (const author of summary.byAuthor) {
    const row_ = document.createElement("div");
    row_.className = "prov-row";
    const swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.style.background = colourFor(author);
    const name = document.createElement("span");
    name.textContent = author.name;
    const share = document.createElement("span");
    share.className = "pct";
    share.textContent = pct(author.share);
    row_.append(swatch, name, share);
    panel.append(row_);
  }

  panel.append(hint(
    "Counted from marks written at the time, not inferred from the text. Text that predates " +
    "Quire is reported as unattributed rather than credited to anyone.",
  ));
}

const colourFor = (author: { authorId: string; kind: string }): string =>
  authorRegistry.get(author.authorId)?.color ??
  (author.kind === "agent" ? "var(--gold)" : author.kind === "human" ? "var(--iris)" : "var(--muted)");

async function startReplay(): Promise<void> {
  if (!current) return;
  toast("Building replay…");
  try {
    const { frames } = await api<{ frames: typeof replayFrames }>(
      `/api/replay?doc=${encodeURIComponent(current)}&frames=60`,
    );
    if (frames.length < 2) return toast("Not enough history to replay this document yet.", true);
    replayFrames = frames;
    document.querySelector(".toast")?.remove();
    replayBar.hidden = false;
    document.body.classList.add("replaying");
    replayRange.max = String(frames.length - 1);
    replayRange.value = String(frames.length - 1);
    void showFrame(frames.length - 1);
  } catch (error) {
    toast((error as Error).message, true);
  }
}

let frameToken = 0;

/**
 * Show one replay position.
 *
 * Text is fetched per frame rather than shipped up front: a 160-frame replay of a large
 * document would otherwise carry the whole document 160 times over. A token guards
 * against a slow response for an earlier position landing after a later one.
 */
async function showFrame(index: number): Promise<void> {
  const frame = replayFrames[index];
  if (!frame || !current) return;
  replayLabel.textContent = `${pct(frame.at)} · ${frame.totalChars} chars`;

  const token = ++frameToken;
  try {
    const { text } = await api<{ text: string }>(
      `/api/replay/frame?doc=${encodeURIComponent(current)}&at=${frame.at}`,
    );
    if (token !== frameToken) return;
    await renderPreview(previewEl, text, { resolveLink: () => null, onNavigate: () => {} });
  } catch {
    if (token === frameToken) replayLabel.textContent = "could not load that moment";
  }
}

replayRange.oninput = () => void showFrame(Number(replayRange.value));
$<HTMLButtonElement>("#replay-close").onclick = () => {
  replayBar.hidden = true;
  document.body.classList.remove("replaying");
  replayFrames = [];
  void paintPreview();
};

insightBtn.onclick = () => {
  openMenu(insightBtn, (panel) => {
    panel.append(heading("Provenance"));
    const slot = document.createElement("div");
    panel.append(slot);
    slot.append(hint("Reading…"));

    void (async () => {
      try {
        const { summary, policy } = await api<{
          summary: ProvenanceSummary;
          policy: { mode: string; maxInserts: number; maxDeletes: number; lockedSections: string[] };
        }>(`/api/provenance?doc=${encodeURIComponent(current ?? "")}`);
        slot.replaceChildren();
        renderProvenance(slot, summary);

        panel.append(document.createElement("hr"), heading("Agent leash"));
        panel.append(row("Agents may", segmented(
          [
            { value: "edit" as const, label: "Edit" },
            { value: "propose" as const, label: "Propose" },
            { value: "read-only" as const, label: "Read" },
          ],
          policy.mode as "edit",
          (mode) => {
            void api(`/api/policy?doc=${encodeURIComponent(current ?? "")}&mode=${mode}`, { method: "POST" })
              .then(() => toast(`Agents may now ${mode === "read-only" ? "only read" : mode} this document.`));
          },
        )));
        panel.append(hint(
          `Budgets are enforced by the server, not requested in a prompt: ${policy.maxInserts} characters inserted and ${policy.maxDeletes} deleted per agent session.`,
        ));

        panel.append(document.createElement("hr"));
        if (historyEnabled) {
          panel.append(menuItem("Replay this document", "watch it being written", () => void startReplay()));
        } else {
          panel.append(hint(
            "Replay needs edit history, which is off by default because retaining it makes " +
            "document state grow with every edit rather than with document size. Restart " +
            "with --history to turn it on.",
          ));
        }
      } catch (error) {
        slot.replaceChildren();
        slot.append(hint((error as Error).message));
      }
    })();
  });
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
        if (t.assignedTo) {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.textContent = "assigned";
          who.append(chip);
        }
        const quote = document.createElement("blockquote");
        quote.textContent = t.quote;
        const body = document.createElement("p");
        body.textContent = t.body;
        card.append(who, quote, body);

        for (const reply of t.replies ?? []) {
          const line = document.createElement("p");
          line.className = "reply";
          line.textContent = `${reply.authorName}: ${reply.body}`;
          card.append(line);
        }

        const actions = document.createElement("div");
        actions.className = "actions";
        if (t.range) {
          const go = document.createElement("button");
          go.textContent = "Show";
          go.onclick = () => scrollTo(view!, t.range!.from, t.range!.to);
          actions.append(go);
        }
        // Assigning a thread to an agent is what closes the loop between review and work:
        // today that round trip means copying context into a chat window by hand.
        const assign = document.createElement("button");
        assign.textContent = t.assignedTo ? "Unassign" : "Assign";
        assign.title = t.assignedTo
          ? `Assigned to ${t.assignedTo}`
          : "Hand this thread to an agent, which will answer with a suggestion";
        assign.onclick = () => {
          const agents = [...authorRegistry.entries()].filter(([, a]) => a.kind === "agent");
          if (!t.assignedTo && agents.length === 0) {
            return toast("No agent has joined this document yet.", true);
          }
          comments!.assign(t.id, t.assignedTo ? null : agents[0]![0]);
          renderRail();
        };
        actions.append(assign);

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

/**
 * Offer to run a fenced code block.
 *
 * Only ever on an explicit click, and only when the server was started with --allow-exec.
 * Opening a document must never run anything, or a document installed from Discover could
 * execute itself.
 */
function attachRunButtons(): void {
  if (!execEnabled) return;
  for (const block of previewEl.querySelectorAll<HTMLElement>("pre > code[class*='language-']")) {
    const language = (block.className.match(/language-(\w+)/)?.[1] ?? "").toLowerCase();
    if (!["bash", "sh", "shell", "zsh", "python", "python3", "node", "javascript"].includes(language)) continue;
    const pre = block.parentElement;
    if (!pre || pre.querySelector(".run-block")) continue;

    const run = document.createElement("button");
    run.className = "run-block";
    run.textContent = `Run ${language}`;
    run.onclick = async () => {
      run.disabled = true;
      run.textContent = "Running…";
      try {
        const res = await fetch("/api/exec", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ language, source: block.textContent ?? "", path: current }),
        });
        const body = (await res.json()) as { markdown?: string; error?: string };
        if (body.error) throw new Error(body.error);
        // Record the output in the document, attributed like any other edit.
        if (ytext && body.markdown) {
          const source = block.textContent ?? "";
          const at = ytext.toString().indexOf(source);
          const insertAt = at === -1 ? ytext.length : at + source.length + 4;
          ytext.doc?.transact(() => ytext!.insert(Math.min(insertAt, ytext!.length), body.markdown!));
        }
        toast("Ran, and recorded the output in the document.");
      } catch (error) {
        toast((error as Error).message, true);
      } finally {
        run.disabled = false;
        run.textContent = `Run ${language}`;
      }
    };
    pre.append(run);
  }
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
  attachRunButtons();
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
  const shareToken = new URLSearchParams(location.search).get("share");
  if (shareToken) url.searchParams.set("share", shareToken);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  // Local-first: the document is readable and editable from IndexedDB before -- and
  // without -- a server round trip.
  persistence = new IndexeddbPersistence(`quire:${epoch}:${path}`, doc);

  provider = new SyncProvider(url.toString(), doc, (connected) => {
    offline = !connected;
    setStatus(connected ? "live" : "offline", connected);
  });
  registerLocalAuthor(doc, me.id, me.name, me.color);
  configureSuggesting(ytext, { id: me.id, name: me.name, color: me.color, kind: "human" });
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
        suggestingExtension(),
        // The server enforces this too; the editor reflects it so a reviewer is not
        // typing into text that will be silently discarded.
        EditorState.readOnly.of(shareRole === "view" || shareRole === "comment"),
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

suggestBtn.onclick = () => {
  const next = !isSuggesting();
  setSuggesting(next);
  suggestBtn.setAttribute("aria-pressed", String(next));
  toast(next
    ? "Suggesting: your edits become proposals and stay off disk until accepted."
    : "Editing directly again.");
};

exportBtn.onclick = () => {
  openMenu(exportBtn, (panel) => {
    const path = current ?? "document.md";
    const text = () => (ytext ? committedTextOf(ytext) : "");
    panel.append(
      heading("Download"),
      menuItem("Markdown", ".md", () => downloadMarkdown(path, text())),
      menuItem("HTML", "self-contained", () => downloadHtml(path, previewEl.innerHTML)),
      menuItem("Plain text", ".txt", () => downloadText(path, text())),
      document.createElement("hr"),
      heading("Copy"),
      menuItem("Copy Markdown", "", () => void copyToClipboard(text()).then(() => toast("Markdown copied"))),
      menuItem("Formatted", "paste into Docs", () =>
        void copyRichText(previewEl.innerHTML, text()).then(() => toast("Copied with formatting"))),
      document.createElement("hr"),
      menuItem("Print", "or save as PDF", () => printDocument()),
      menuItem("Provenance receipt", "a page you can share", () => {
        // Opened rather than downloaded: the point is that it is a link.
        window.open(`/api/receipt?doc=${encodeURIComponent(path)}`, "_blank", "noopener");
      }),
    );
  });
};


/**
 * Direct peer editing. Signalling is a copy-paste, because a signalling server is exactly
 * the middleman this is meant to avoid.
 */
async function startPeerOffer(): Promise<void> {
  if (!doc) return;
  peer?.close();
  try {
    peer = await offerPeer(doc, (state, detail) => {
      if (state === "connected") toast("Peer connected. You are editing directly.");
      else if (state === "failed") toast(detail ?? "Direct connection failed.", true);
    });
    await copyToClipboard(peer.invite);
    const reply = window.prompt(
      "Invite copied to your clipboard. Send it to the other person, then paste their reply here.",
    );
    if (reply?.trim()) {
      await peer.accept(reply);
      toast("Reply accepted — connecting…");
    }
  } catch (error) {
    toast((error as Error).message, true);
  }
}

async function joinPeer(): Promise<void> {
  if (!doc) return;
  const invite = window.prompt("Paste the invite you were sent:");
  if (!invite?.trim()) return;
  try {
    peer?.close();
    peer = await answerPeer(doc, invite, (state, detail) => {
      if (state === "connected") toast("Connected directly to your peer.");
      else if (state === "failed") toast(detail ?? "Direct connection failed.", true);
    });
    await copyToClipboard(peer.invite);
    toast("Your reply is on the clipboard — send it back to them.");
  } catch (error) {
    toast((error as Error).message, true);
  }
}


/**
 * Ask someone to look at a document.
 *
 * This is the growth loop worth having: the invitation does the recruiting, and the
 * reviewer needs no account, no install, and no explanation of what Quire is.
 */
async function requestReview(): Promise<void> {
  if (!current) return;
  const brief = window.prompt(
    "What would you like them to look at?\n\n(They will see this, and can comment without an account.)",
    "Does this read clearly?",
  );
  if (brief === null) return;

  try {
    const params = new URLSearchParams({ role: "comment", path: current, brief, by: me.name });
    const share = await api<{ token: string }>(`/api/share?${params}`, { method: "POST" });
    const link = new URL(location.href);
    link.search = "";
    link.searchParams.set("share", share.token);
    link.searchParams.set("doc", current);
    await copyToClipboard(link.toString());
    toast("Review link copied. They can comment without signing up.");
  } catch (error) {
    toast((error as Error).message, true);
  }
}

shareBtn.onclick = () => {
  openMenu(shareBtn, (panel) => {
    panel.append(heading("Share a link"));

    let role: "view" | "comment" | "edit" = "view";
    panel.append(row("Access", segmented(
      [
        { value: "view" as const, label: "View" },
        { value: "comment" as const, label: "Comment" },
        { value: "edit" as const, label: "Edit" },
      ],
      role,
      (value) => { role = value; },
    )));

    let scoped = true;
    panel.append(row("Scope", segmented(
      [{ value: "doc" as const, label: "This file" }, { value: "all" as const, label: "Whole vault" }],
      "doc",
      (value) => { scoped = value === "doc"; },
    )));

    const create = document.createElement("button");
    create.className = "menu-item";
    create.textContent = "Create link";
    const field = document.createElement("div");
    field.className = "share-field";
    field.hidden = true;
    const input = document.createElement("input");
    input.readOnly = true;
    const copy = document.createElement("button");
    copy.className = "ghost-sm";
    copy.textContent = "Copy";
    field.append(input, copy);

    create.onclick = async () => {
      try {
        const params = new URLSearchParams({ role });
        if (scoped && current) params.set("path", current);
        const share = await api<{ token: string }>(`/api/share?${params}`, { method: "POST" });
        const link = new URL(location.href);
        link.search = "";
        link.searchParams.set("share", share.token);
        if (scoped && current) link.searchParams.set("doc", current);
        input.value = link.toString();
        field.hidden = false;
        input.select();
      } catch (error) {
        toast((error as Error).message, true);
      }
    };
    copy.onclick = () => void copyToClipboard(input.value).then(() => toast("Link copied"));

    panel.append(create, field, hint(
      "Anyone with the link gets that access — there are no accounts, so the link is the key. " +
      "View is enforced by the server. Links die when the server stops.",
    ));

    panel.append(document.createElement("hr"), heading("Request a review"));
    panel.append(menuItem("Ask someone to review this", "no account needed", () => void requestReview()));

    panel.append(document.createElement("hr"), heading("Direct connection"));
    panel.append(menuItem("Invite a peer", "no server at all", () => void startPeerOffer()));
    panel.append(menuItem("Join with an invite", "paste theirs", () => void joinPeer()));
  });
};


/**
 * The theme picker.
 *
 * Each option previews itself: the swatch is painted with that theme's own ground, accent
 * and agent colours, so the choice is made by eye rather than by reading names. "System"
 * leads because it is the only option that changes with the time of day.
 */
function themePicker(current: string, onPick: (id: string) => void): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "theme-grid";

  const option = (id: string, name: string, note: string, colors: string[]): HTMLElement => {
    const button = document.createElement("button");
    button.className = "theme-swatch";
    button.type = "button";
    button.title = note;
    button.setAttribute("aria-pressed", String(current === id));

    const chips = document.createElement("span");
    chips.className = "chips";
    for (const colour of colors) {
      const chip = document.createElement("i");
      chip.style.background = colour;
      chips.append(chip);
    }
    const label = document.createElement("span");
    label.className = "label";
    label.textContent = name;

    button.append(chips, label);
    button.onclick = () => {
      for (const sibling of wrap.querySelectorAll("[aria-pressed]")) {
        sibling.setAttribute("aria-pressed", "false");
      }
      button.setAttribute("aria-pressed", "true");
      onPick(id);
    };
    return button;
  };

  const auto = resolveTheme("system");
  wrap.append(
    option("system", "System", `Follows your device — currently ${auto.name}.`, [
      auto.colors.base, auto.colors.iris, auto.colors.gold, auto.colors.text,
    ]),
    ...THEMES.map((theme) =>
      option(theme.id, theme.name, theme.note, [
        theme.colors.base, theme.colors.iris, theme.colors.gold, theme.colors.text,
      ]),
    ),
  );
  return wrap;
}

displayBtn.onclick = () => {
  openMenu(displayBtn, (panel) => {
    const update = (patch: Partial<DisplaySettings>): void => {
      display = { ...display, ...patch };
      applySettings(display);
      if (patch.theme !== undefined) applyTheme(resolveTheme(display.theme));
      saveSettings(display);
    };
    panel.append(
      heading("Theme"),
      themePicker(display.theme, (theme) => update({ theme })),
      document.createElement("hr"),
      heading("Reading"),
      row("Prose", segmented(
        [
          { value: "serif" as const, label: "Serif" },
          { value: "sans" as const, label: "Sans" },
          { value: "mono" as const, label: "Mono" },
        ],
        display.proseFont,
        (proseFont) => update({ proseFont }),
      )),
      row("Editor", segmented(
        [
          { value: "mono" as const, label: "Mono" },
          { value: "sans" as const, label: "Sans" },
          { value: "serif" as const, label: "Serif" },
        ],
        display.editorFont,
        (editorFont) => update({ editorFont }),
      )),
      slider("Size", display.fontSize, { min: 13, max: 24, step: 0.5, suffix: "px" },
        (fontSize) => update({ fontSize })),
      slider("Leading", display.lineHeight, { min: 1.3, max: 2.2, step: 0.02 },
        (lineHeight) => update({ lineHeight })),
      slider("Width", display.measure, { min: 45, max: 100, step: 1, suffix: "ch" },
        (measure) => update({ measure })),
      document.createElement("hr"),
      menuItem(display.focusMode ? "Leave focus mode" : "Focus mode", "just the page",
        () => update({ focusMode: !display.focusMode })),
      hint("Display only. Nothing here changes a byte of the file, so two people can read the same document at settings that suit each of them."),
    );
  });
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
  } else if (mod && event.shiftKey && event.key.toLowerCase() === "s") {
    event.preventDefault();
    suggestBtn.click();
  } else if (mod && event.key === "\\") {
    event.preventDefault();
    togglePanel(event.shiftKey ? "rail" : "sidebar");
  } else if (mod && event.shiftKey && event.key.toLowerCase() === "e") {
    event.preventDefault();
    togglePanel("editor");
  } else if (mod && event.key.toLowerCase() === "p") {
    event.preventDefault();
    printDocument();
  } else if (mod && event.shiftKey && event.key.toLowerCase() === "a") {
    event.preventDefault();
    attrBtn.click();
  } else if (event.key === "Escape" && document.activeElement === searchEl) {
    searchEl.value = "";
    renderFiles(allFiles);
    view?.focus();
  }
});

applySettings(display);
applyTheme(resolveTheme(display.theme));
// Only relevant while the preference is "system"; harmless otherwise.
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (display.theme === "system") applyTheme(resolveTheme("system"));
});
suggestBtn.setAttribute("aria-pressed", "false");

// Panels: restore the saved arrangement, then make the dividers draggable.
loadLayout();
applyLayout();
// Each panel closes itself; a stub at the edge brings it back.
for (const [selector, panel] of [
  ["#close-sidebar", "sidebar"],
  ["#sidebar-stub", "sidebar"],
  ["#close-rail", "rail"],
  ["#rail-stub", "rail"],
  ["#close-editor", "editor"],
  ["#editor-stub", "editor"],
] as const) {
  $<HTMLButtonElement>(selector).onclick = () => togglePanel(panel);
}
wireResizer($("#rz-sidebar"), "sidebar");
wireResizer($("#rz-rail"), "rail");
wireResizer($("#rz-editor"), "editor", splitEl);

/**
 * A review request opens the document with a brief and a limited role.
 *
 * The reviewer needs no account and installs nothing: the link is the credential, and the
 * role attached to it is enforced by the server rather than by hiding buttons.
 */
async function applyShareLink(): Promise<void> {
  const token = new URLSearchParams(location.search).get("share");
  if (!token) return;

  try {
    const info = await api<{
      role: "view" | "comment" | "edit";
      path: string | null;
      brief: string | null;
      requestedBy: string | null;
    }>(`/api/share/info?token=${encodeURIComponent(token)}`);

    shareRole = info.role;
    document.body.classList.toggle("commenting", info.role === "comment");

    if (info.brief || info.role !== "edit") {
      const banner = $("#review-banner");
      $("#review-title").textContent = info.requestedBy
        ? `${info.requestedBy} asked you to review this`
        : info.brief
          ? "You have been asked to review this"
          : "You are viewing a shared document";
      $("#review-brief").textContent =
        info.brief ??
        (info.role === "comment"
          ? "You can leave comments. The text itself is not yours to change."
          : "This link is read-only.");
      $("#review-role").textContent =
        info.role === "comment" ? "Comment access" : info.role === "view" ? "Read only" : "Edit access";
      banner.hidden = false;
    }

    // Editing controls that cannot work under this role should not be offered.
    if (info.role !== "edit") {
      for (const id of ["#suggest-btn", "#snapshot-btn", "#share-btn"]) {
        $<HTMLButtonElement>(id).hidden = true;
      }
    }
  } catch {
    toast("That share link is not valid, or has expired.", true);
  }
}

async function boot(): Promise<void> {
  try {
    const info = await api<{
      files: string[]; epoch: string; git: boolean; githubSearch: boolean;
      exec?: boolean; history?: boolean;
    }>("/api/files");
    allFiles = info.files;
    epoch = info.epoch;
    gitAvailable = info.git;
    githubSearchOn = info.githubSearch;
    execEnabled = info.exec ?? false;
    historyEnabled = info.history ?? false;
  } catch {
    setStatus("server unreachable", false);
    pathEl.textContent = "Cannot reach the Quire server. Is it still running?";
    return;
  }

  await applyShareLink();
  await purgeStaleOfflineStores();
  snapshotBtn.hidden = !gitAvailable;

  registry = await api<Registry>("/api/registry").catch(() => registry);

  // Which installed documents have drifted from their source.
  void api<{ documents: Array<{ path: string; state: string }> }>("/api/drift")
    .then(({ documents }) => {
      for (const d of documents) driftByPath.set(d.path, d.state);
      if (documents.some((d) => d.state !== "current")) renderFiles(allFiles);
    })
    .catch(() => {});
  modeDiscoverBtn.hidden = !registry.available;
  if (registry.available) {
    discoverNoteEl.textContent = registry.note ?? "";
    renderCategories();
  }

  renderFiles(allFiles);
  await refreshLinks().catch(() => {});

  const wanted = new URLSearchParams(location.search).get("doc");
  if (wanted && allFiles.includes(wanted)) await open(wanted);
  else if (allFiles[0]) await open(allFiles[0]);
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
