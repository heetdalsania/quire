/**
 * Getting a document out of Quire.
 *
 * All of this is deliberately client-side: the document is already in the browser, so
 * exporting needs no round trip, works offline, and never sends your text anywhere.
 */

const download = (blob: Blob, filename: string): void => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  // Revoke on the next frame; revoking immediately cancels the download in some browsers.
  requestAnimationFrame(() => URL.revokeObjectURL(url));
};

const baseName = (path: string): string => (path.split("/").pop() ?? path).replace(/\.(md|markdown)$/i, "");

export function downloadMarkdown(path: string, text: string): void {
  download(new Blob([text], { type: "text/markdown;charset=utf-8" }), `${baseName(path)}.md`);
}

export function downloadText(path: string, text: string): void {
  // Strip the lightest markdown scaffolding so the result reads as plain prose.
  const plain = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^\s*[-*+]\s+/gm, "• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, a, b) => b ?? a);
  download(new Blob([plain], { type: "text/plain;charset=utf-8" }), `${baseName(path)}.txt`);
}

/** A self-contained HTML file: styles inlined, nothing fetched, opens anywhere. */
export function downloadHtml(path: string, renderedHtml: string): void {
  const title = baseName(path);
  const doc = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; --ink:#464261; --paper:#fffaf3; --muted:#797593; --rule:#e5ddd4; --link:#286983; }
  @media (prefers-color-scheme: dark) { :root { --ink:#e0def4; --paper:#232136; --muted:#908caa; --rule:#393552; --link:#9ccfd8; } }
  body { margin:0; padding:48px 24px 96px; background:var(--paper); color:var(--ink);
    font:17px/1.72 "Iowan Old Style","Palatino Linotype",Palatino,Charter,Georgia,serif; }
  main { max-width:64ch; margin:0 auto; }
  h1,h2,h3,h4 { font-family:ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif;
    line-height:1.25; letter-spacing:-0.02em; margin:1.9em 0 .5em; }
  h1 { font-size:1.9em; font-weight:660; } h2 { font-size:1.25em; font-weight:640; }
  a { color:var(--link); text-underline-offset:2px; }
  blockquote { margin:1.4em 0; padding-left:1.1em; border-left:2px solid var(--rule); color:var(--muted); font-style:italic; }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:.85em;
    background:color-mix(in srgb, var(--ink) 7%, transparent); padding:.14em .38em; border-radius:4px; }
  pre { background:color-mix(in srgb, var(--ink) 5%, transparent); padding:14px 16px;
    border-radius:9px; overflow-x:auto; } pre code { background:none; padding:0; }
  table { border-collapse:collapse; font-family:ui-sans-serif,system-ui,sans-serif; font-size:.9em; }
  th,td { border:1px solid var(--rule); padding:6px 11px; text-align:left; }
  img,svg { max-width:100%; height:auto; }
  hr { border:0; height:1px; background:var(--rule); margin:2.4em 0; }
  footer { max-width:64ch; margin:64px auto 0; padding-top:16px; border-top:1px solid var(--rule);
    font-family:ui-sans-serif,system-ui,sans-serif; font-size:12px; color:var(--muted); }
  @media print { body { padding:0; background:#fff; color:#000; } footer { display:none; } }
</style></head>
<body><main>${renderedHtml}</main>
<footer>${escapeHtml(path)} — exported from Quire on ${new Date().toLocaleDateString()}</footer>
</body></html>`;
  download(new Blob([doc], { type: "text/html;charset=utf-8" }), `${title}.html`);
}

export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

/** Copy the rendered document so it pastes into Docs or Word with formatting intact. */
export async function copyRichText(renderedHtml: string, plain: string): Promise<void> {
  if (typeof ClipboardItem === "undefined") return copyToClipboard(plain);
  await navigator.clipboard.write([
    new ClipboardItem({
      "text/html": new Blob([renderedHtml], { type: "text/html" }),
      "text/plain": new Blob([plain], { type: "text/plain" }),
    }),
  ]);
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);

/**
 * Print, and by extension "save as PDF", which is how every browser exposes PDF export.
 * The print stylesheet hides the app chrome and prints the rendered document only.
 */
export function printDocument(): void {
  window.print();
}
