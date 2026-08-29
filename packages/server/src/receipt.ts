import {
  type DocHandle,
  allRuns,
  buildReplay,
  knownAuthors,
  suggestionOutcomes,
  summarise,
} from "@quire/bridge";

/**
 * The receipt.
 *
 * A shareable page asserting what a document is actually made of: how much a person wrote,
 * how much an agent did, which suggestions were accepted, and -- when history is on -- a
 * replay of it being written.
 *
 * This is packaging rather than invention. Every number here comes from marks laid down at
 * write time, which is the point: any editor could produce a document, but only one that
 * recorded provenance as it happened can produce a receipt afterwards. It cannot be
 * retrofitted, faked from the finished text, or inferred by a detector.
 *
 * The output is a single self-contained HTML file with no external requests, so it can be
 * emailed, committed, or hosted anywhere and still work years later.
 */

export interface ReceiptOptions {
  /** Include a scrubable replay. Requires the vault to be running with history. */
  replay?: boolean;
  /** Cap on embedded replay frames, to keep the file a sane size. */
  maxFrames?: number;
}

export interface ReceiptData {
  path: string;
  generatedAt: string;
  humanShare: number;
  agentShare: number;
  unattributedShare: number;
  totalChars: number;
  contributors: Array<{ name: string; kind: string; share: number; chars: number; color: string }>;
  runs: number;
  models: string[];
  spanDays: number;
  accepted: number;
  rejected: number;
  frames: Array<{ at: number; text: string }>;
}

const DAY_MS = 86_400_000;

export function collectReceipt(handle: DocHandle, options: ReceiptOptions = {}): ReceiptData {
  const authors = knownAuthors(handle.doc) as Record<string, { name: string; kind: "human" | "agent"; color?: string }>;
  const summary = summarise(handle.doc, handle.text, authors as never);
  const runs = allRuns(handle.doc);
  const outcomes = suggestionOutcomes(handle.doc);

  const stamps = runs.map((r) => r.startedAt).filter(Boolean);
  const spanDays =
    stamps.length > 1 ? Math.max(1, Math.round((Math.max(...stamps) - Math.min(...stamps)) / DAY_MS)) : 1;

  let frames: ReceiptData["frames"] = [];
  if (options.replay) {
    const budget = options.maxFrames ?? 24;
    // Embedding every frame would put the whole document in the file once per frame.
    // Committed text only: a receipt should show what the file said, not proposals
    // that were never accepted into it.
    const built = buildReplay(handle.doc, "content", { frames: budget, withText: true, committed: true });
    const step = Math.max(1, Math.ceil(built.length / budget));
    frames = built
      .filter((_, i) => i % step === 0 || i === built.length - 1)
      .map((f) => ({ at: f.at, text: f.text ?? "" }));
  }

  return {
    path: handle.path,
    generatedAt: new Date().toISOString(),
    humanShare: summary.humanShare,
    agentShare: summary.agentShare,
    unattributedShare: summary.unattributedShare,
    totalChars: summary.totalChars,
    contributors: summary.byAuthor.map((a) => ({
      name: a.name,
      kind: a.kind,
      share: a.share,
      chars: a.chars,
      color: authors[a.authorId]?.color ?? (a.kind === "agent" ? "#ea9d34" : a.kind === "human" ? "#907aa9" : "#9893a5"),
    })),
    runs: runs.length,
    models: [...new Set(runs.map((r) => r.model).filter((m): m is string => Boolean(m)))],
    spanDays,
    accepted: outcomes.filter((o) => o.action === "accepted").length,
    rejected: outcomes.filter((o) => o.action === "rejected").length,
    frames,
  };
}

const escape = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const pct = (n: number): string => `${Math.round(n * 100)}%`;

/** Render the receipt as one self-contained HTML file. */
export function renderReceipt(data: ReceiptData): string {
  const headline = data.unattributedShare > 0.5
    ? `${pct(data.unattributedShare)} of this document predates Quire`
    : `${pct(data.humanShare)} human · ${pct(data.agentShare)} agent`;

  const bars = data.contributors
    .map(
      (c) =>
        `<span style="width:${(c.share * 100).toFixed(2)}%;background:${escape(c.color)}" title="${escape(c.name)} — ${pct(c.share)}"></span>`,
    )
    .join("");

  const rows = data.contributors
    .map(
      (c) => `<tr>
        <td><i style="background:${escape(c.color)}"></i>${escape(c.name)}</td>
        <td class="kind">${escape(c.kind)}</td>
        <td class="num">${c.chars.toLocaleString()}</td>
        <td class="num strong">${pct(c.share)}</td>
      </tr>`,
    )
    .join("");

  const reviewed = data.accepted + data.rejected;
  const facts = [
    ["Contributions", `${data.runs}`],
    ["Suggestions reviewed", reviewed > 0 ? `${data.accepted} accepted · ${data.rejected} rejected` : "none"],
    ["Written over", data.spanDays === 1 ? "a single day" : `${data.spanDays} days`],
    ["Length", `${data.totalChars.toLocaleString()} characters`],
    ...(data.models.length ? [["Models", data.models.join(", ")] as const] : []),
  ]
    .map(([label, value]) => `<div class="fact"><dt>${escape(label)}</dt><dd>${escape(String(value))}</dd></div>`)
    .join("");

  const replayBlock = data.frames.length > 1
    ? `<section class="replay">
      <h2>Watch it being written</h2>
      <input id="scrub" type="range" min="0" max="${data.frames.length - 1}" value="${data.frames.length - 1}" aria-label="Replay position" />
      <pre id="stage"></pre>
    </section>
    <script id="frames" type="application/json">${JSON.stringify(data.frames).replace(/</g, "\\u003c")}</script>
    <script>
      (function () {
        var frames = JSON.parse(document.getElementById("frames").textContent);
        var stage = document.getElementById("stage");
        var scrub = document.getElementById("scrub");
        function show(i) { stage.textContent = frames[i] ? frames[i].text : ""; }
        scrub.addEventListener("input", function () { show(Number(scrub.value)); });
        show(frames.length - 1);
      })();
    </script>`
    : "";

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escape(data.path)} — provenance receipt</title>
<style>
  :root { color-scheme: light dark;
    --paper:#faf4ed; --card:#fffaf3; --ink:#464261; --muted:#797593; --rule:#e5ddd4; --accent:#907aa9; }
  @media (prefers-color-scheme: dark) { :root {
    --paper:#232136; --card:#2a273f; --ink:#e0def4; --muted:#908caa; --rule:#393552; --accent:#c4a7e7; } }
  * { box-sizing:border-box; }
  body { margin:0; padding:56px 20px 90px; background:var(--paper); color:var(--ink);
    font:16px/1.6 ui-sans-serif,-apple-system,"Segoe UI",system-ui,sans-serif; -webkit-font-smoothing:antialiased; }
  main { max-width:660px; margin:0 auto; }
  .doc { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; color:var(--muted); }
  h1 { font-size:30px; line-height:1.2; letter-spacing:-0.03em; margin:6px 0 22px; }
  .bar { display:flex; height:12px; border-radius:6px; overflow:hidden; background:var(--rule); margin-bottom:10px; }
  .bar span { display:block; }
  table { width:100%; border-collapse:collapse; margin:18px 0 30px; font-size:14px; }
  td { padding:7px 0; border-bottom:1px solid var(--rule); }
  td i { display:inline-block; width:9px; height:9px; border-radius:3px; margin-right:9px; vertical-align:middle; }
  .kind { color:var(--muted); font-size:12px; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }
  .strong { font-weight:650; }
  .facts { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; margin-bottom:34px; }
  .fact { background:var(--card); border:1px solid var(--rule); border-radius:11px; padding:13px 15px; }
  dt { font-size:11px; text-transform:uppercase; letter-spacing:0.08em; color:var(--muted); margin-bottom:4px; }
  dd { margin:0; font-size:15px; font-weight:560; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:0.09em; color:var(--muted); margin:0 0 12px; }
  .replay input { width:100%; accent-color:var(--accent); margin-bottom:12px; }
  .replay pre { background:var(--card); border:1px solid var(--rule); border-radius:11px;
    padding:16px; min-height:190px; max-height:340px; overflow:auto;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px; line-height:1.65;
    white-space:pre-wrap; margin:0; }
  footer { margin-top:44px; padding-top:16px; border-top:1px solid var(--rule);
    font-size:12px; color:var(--muted); line-height:1.6; }
  a { color:var(--accent); }
</style></head>
<body><main>
  <p class="doc">${escape(data.path)}</p>
  <h1>${escape(headline)}</h1>
  <div class="bar">${bars}</div>
  <table>${rows}</table>
  <div class="facts">${facts}</div>
  ${replayBlock}
  <footer>
    Measured from authorship recorded as the document was written, not inferred from the text.
    Text written before this document was opened in Quire is counted as unattributed rather
    than credited to anyone. Generated ${escape(data.generatedAt.slice(0, 10))} by
    <a href="https://github.com/heetdalsania/quire">Quire</a>.
  </footer>
</main></body></html>`;
}
