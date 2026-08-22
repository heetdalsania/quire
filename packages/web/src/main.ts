import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { marked } from "marked";
import { yCollab } from "y-codemirror.next";
import * as Y from "yjs";
import { SyncProvider } from "./provider.js";

const PALETTE = ["#3b5bdb", "#c2255c", "#2f9e44", "#e8590c", "#7048e8", "#0c8599"];
const ANIMALS = ["Otter", "Heron", "Falcon", "Marten", "Ibex", "Lynx", "Plover", "Vole"];

// Identity is generated locally. No account, no signup, nothing sent anywhere.
const user = {
  name: `${ANIMALS[Math.floor(Math.random() * ANIMALS.length)]}`,
  color: PALETTE[Math.floor(Math.random() * PALETTE.length)]!,
};

const filesEl = document.querySelector<HTMLElement>("#files")!;
const statusEl = document.querySelector<HTMLElement>("#status")!;
const pathEl = document.querySelector<HTMLElement>("#docpath")!;
const presenceEl = document.querySelector<HTMLElement>("#presence")!;
const editorEl = document.querySelector<HTMLElement>("#editor")!;
const previewEl = document.querySelector<HTMLElement>("#preview")!;

let view: EditorView | null = null;
let provider: SyncProvider | null = null;
let doc: Y.Doc | null = null;

async function loadFileList(): Promise<string[]> {
  const res = await fetch("/api/files");
  const body = (await res.json()) as { files: string[] };
  return body.files;
}

function renderFileList(files: string[], active: string | null): void {
  filesEl.replaceChildren(
    ...files.map((path) => {
      const button = document.createElement("button");
      button.textContent = path;
      button.title = path;
      if (path === active) button.setAttribute("aria-current", "true");
      button.onclick = () => void open(path);
      return button;
    }),
  );
}

function renderPresence(): void {
  if (!provider) return;
  const seen = new Map<string, string>();
  for (const [clientId, state] of provider.awareness.getStates()) {
    const u = (state as { user?: { name: string; color: string } }).user;
    if (u) seen.set(`${clientId}`, JSON.stringify(u));
  }
  presenceEl.replaceChildren(
    ...[...seen.values()].map((raw) => {
      const u = JSON.parse(raw) as { name: string; color: string };
      const el = document.createElement("div");
      el.className = "avatar";
      el.style.background = u.color;
      el.textContent = u.name.slice(0, 1);
      el.title = u.name;
      return el;
    }),
  );
}

function renderPreview(text: string): void {
  previewEl.innerHTML = marked.parse(text, { async: false });
}

async function open(path: string): Promise<void> {
  view?.destroy();
  provider?.destroy();
  doc?.destroy();

  doc = new Y.Doc();
  const text = doc.getText("content");
  const url = new URL(`/sync?doc=${encodeURIComponent(path)}`, location.href);
  url.protocol = location.protocol === "https:" ? "wss:" : "ws:";

  provider = new SyncProvider(url.toString(), doc, (connected) => {
    statusEl.textContent = connected ? "live" : "offline";
    statusEl.classList.toggle("live", connected);
  });
  provider.awareness.setLocalStateField("user", user);
  provider.awareness.on("change", renderPresence);

  view = new EditorView({
    parent: editorEl,
    state: EditorState.create({
      extensions: [
        lineNumbers(),
        history(),
        keymap.of([...defaultKeymap, ...historyKeymap]),
        markdown(),
        EditorView.lineWrapping,
        yCollab(text, provider.awareness),
        EditorView.updateListener.of((u) => {
          if (u.docChanged) renderPreview(u.state.doc.toString());
        }),
      ],
    }),
  });

  renderPreview(text.toString());
  text.observe(() => {
    if (view) renderPreview(view.state.doc.toString());
  });

  pathEl.textContent = path;
  renderFileList(await loadFileList(), path);
  renderPresence();
}

const files = await loadFileList();
renderFileList(files, null);
if (files[0]) await open(files[0]);
else pathEl.textContent = "no markdown files in this folder yet";
