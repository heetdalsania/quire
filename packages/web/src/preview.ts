import { marked } from "marked";
import mermaid from "mermaid";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
let mermaidTheme: "dark" | "default" | null = null;

/**
 * Mermaid bakes its palette in at initialize() time, so a diagram rendered before the
 * viewer switched to dark keeps dark-on-dark arrows. Re-initialise whenever the scheme
 * no longer matches what we last configured.
 */
function initMermaid(): void {
  const wanted = darkQuery.matches ? "dark" : "default";
  if (mermaidTheme === wanted) return;
  mermaid.initialize({ startOnLoad: false, theme: wanted, securityLevel: "strict" });
  mermaidTheme = wanted;
}

/** Repaint diagrams when the viewer's colour scheme changes. */
export function onColorSchemeChange(repaint: () => void): void {
  darkQuery.addEventListener("change", () => {
    mermaidTheme = null;
    repaint();
  });
}

/** Rewrite [[wiki links]] into real anchors before Markdown parsing. */
function linkifyWikiLinks(source: string, exists: (target: string) => string | null): string {
  return source.replace(/\[\[([^\]|#]+)(#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_all, target, _hash, label) => {
    const path = exists(String(target).trim());
    const text = String(label ?? target).trim();
    return path
      ? `<a class="wikilink" data-path="${escapeAttr(path)}" href="#">${escapeHtml(text)}</a>`
      : `<span class="wikilink missing" title="No document matches this link">${escapeHtml(text)}</span>`;
  });
}

const escapeHtml = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const escapeAttr = escapeHtml;

export async function renderPreview(
  target: HTMLElement,
  source: string,
  options: { resolveLink: (t: string) => string | null; onNavigate: (path: string) => void },
): Promise<void> {
  const html = marked.parse(linkifyWikiLinks(source, options.resolveLink), { async: false });
  target.innerHTML = html;

  for (const anchor of target.querySelectorAll<HTMLAnchorElement>("a.wikilink")) {
    anchor.onclick = (event) => {
      event.preventDefault();
      const path = anchor.dataset.path;
      if (path) options.onNavigate(path);
    };
  }

  const blocks = [...target.querySelectorAll<HTMLElement>("pre > code.language-mermaid")];
  if (blocks.length === 0) return;

  initMermaid();
  await Promise.all(
    blocks.map(async (block, index) => {
      const container = block.parentElement;
      if (!container) return;
      try {
        const { svg } = await mermaid.render(`mmd-${Date.now()}-${index}`, block.textContent ?? "");
        const figure = document.createElement("figure");
        figure.className = "mermaid-figure";
        figure.innerHTML = svg;
        container.replaceWith(figure);
      } catch (error) {
        // A broken diagram should show its error, not blank the whole preview.
        const pre = document.createElement("pre");
        pre.className = "mermaid-error";
        pre.textContent = `Mermaid error: ${(error as Error).message}`;
        container.replaceWith(pre);
      }
    }),
  );
}
