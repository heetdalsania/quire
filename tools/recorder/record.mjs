import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import puppeteer from "puppeteer-core";

const REPO = "/Users/heet007/Documents/Career/Projects/Quire";
const { AgentSession } = await import(`${REPO}/packages/mcp/dist/src/index.js`);
const { insertAttributed, proposeDelete } = await import(`${REPO}/packages/bridge/dist/src/index.js`);

const URL_ = process.env.QUIRE_URL ?? "http://127.0.0.1:4430";
const OUT = join(import.meta.dirname, "frames");
const W = 1340;
const H = 760;
const FPS = 11;

const agent = { id: "agent-claude", name: "Claude", color: "#ea9d34", kind: "agent" };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await puppeteer.launch({
  executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  headless: "shell",
  args: [`--window-size=${W},${H}`, "--hide-scrollbars", "--force-color-profile=srgb"],
});
const page = await browser.newPage();
await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
await page.goto(URL_, { waitUntil: "networkidle2" });
await page.waitForSelector(".cm-content", { timeout: 15000 });

// Open spec.md.
await page.evaluate(() => {
  const btn = [...document.querySelectorAll("#files button")].find((b) => b.textContent.includes("spec.md"));
  btn?.click();
});
await sleep(900);

// ---- frame capture loop, independent of the choreography ----------------
let frame = 0;
let recording = true;
const capture = (async () => {
  while (recording) {
    const t0 = Date.now();
    try {
      await page.screenshot({ path: join(OUT, `f${String(frame++).padStart(4, "0")}.png`) });
    } catch { /* page busy; skip this frame */ }
    const wait = Math.max(0, 1000 / FPS - (Date.now() - t0));
    await sleep(wait);
  }
})();

/** Type into the editor the way a person does, not as a paste. */
async function humanType(text, perChar = 42) {
  await page.focus(".cm-content");
  for (const ch of text) {
    await page.keyboard.type(ch);
    await sleep(perChar);
  }
}

async function placeCursorAfter(needle) {
  await page.evaluate((n) => {
    const view = window.__quireView;
    if (!view) return;
    const idx = view.state.doc.toString().indexOf(n);
    if (idx >= 0) view.dispatch({ selection: { anchor: idx + n.length }, scrollIntoView: true });
  }, needle);
  await page.focus(".cm-content");
}

// ---- choreography --------------------------------------------------------
await sleep(1200);

// 1. A person is writing.
await placeCursorAfter("only component permitted to move money.");
await humanType(" Nothing else touches the ledger.");
await sleep(700);

// 2. An agent joins the same session. Its avatar appears in the presence bar.
const session = new AgentSession(URL_, "spec.md", agent);
await session.connect();
session.announce();
await sleep(1300);

// 3. The agent edits LIVE, at a different place, while the human keeps typing.
const target = "The service handles charges.";
const replacement = "The service handles charges, refunds, and disputes.";
const at = session.text.toString().indexOf(target);
session.doc.transact(() => session.text.delete(at, target.length), `author:${agent.id}`);
for (let i = 0; i < replacement.length; i++) {
  insertAttributed(session.text, at + i, replacement[i], agent);
  session.announce({ anchor: at + i + 1, head: at + i + 1 });
  await sleep(28);
}

// The human types straight through it -- no conflict, no reload.
await placeCursorAfter("Nothing else touches the ledger.");
await humanType(" Retries are always safe.", 38);
await sleep(900);

// 4. The agent proposes a change instead of applying it.
const old = "Errors are returned as JSON.";
const proposal = "Errors are returned as RFC 9457 problem documents.";
const oldAt = session.text.toString().indexOf(old);
proposeDelete(session.text, oldAt, oldAt + old.length, agent, "demo-1");
for (let i = 0; i < proposal.length; i++) {
  insertAttributed(session.text, oldAt + old.length + i, proposal[i], agent, { suggestion: "demo-1" });
  await sleep(20);
}
await sleep(1600);

// 5. The human accepts it, and it lands on disk.
await page.evaluate(() => {
  [...document.querySelectorAll("#suggestions button")].find((b) => b.textContent === "Accept")?.click();
});
await sleep(1500);

// 6. Reveal authorship.
await page.click("#attr-btn");
await sleep(2200);

recording = false;
await capture;
await writeFile(join(OUT, "meta.json"), JSON.stringify({ frames: frame, fps: FPS, width: W, height: H }));
session.close();
await browser.close();
console.log(`captured ${frame} frames at ${FPS}fps (${(frame / FPS).toFixed(1)}s)`);
