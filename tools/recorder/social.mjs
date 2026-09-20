import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { QuireServer } from "../../packages/server/dist/src/index.js";
import { AgentSession } from "../../packages/mcp/dist/src/index.js";
import { insertAttributed, proposeDelete } from "../../packages/bridge/dist/src/index.js";

const out = resolve(process.env.OUT_DIR ?? join(import.meta.dirname, "output"));
await mkdir(out, { recursive: true });
const root = await mkdtemp(join(tmpdir(), "quire-social-"));
const author = { id: "demo-agent", name: "Demo agent", color: "#c48720", kind: "agent" };
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let server;
let browser;
try {
  const source = "# Retry policy\n\n## Requirements\n\nRetry limit: 3 attempts.\n\n## Review notes\n\n";
  for (const name of ["01-write-together", "02-review-suggestions", "03-revert-agent"])
    await writeFile(join(root, `${name}.md`), source);
  server = await QuireServer.start({ root, port: 0, git: false, persist: false,
    webRoot: resolve("packages/web/dist") });
  const base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();
  for (const name of ["01-write-together", "02-review-suggestions", "03-revert-agent"]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light" });
    const page = await context.newPage();
    const path = `${name}.md`;
    const frames = join(out, `${name}-frames`);
    await mkdir(frames, { recursive: true });
    const agent = new AgentSession(base, path, author);
    let recording = false;
    let capture;
    let frame = 0;
    try {
      await page.goto(`${base}/?doc=${path}`);
      await expect(page.locator(".status-text")).toHaveText("live");
      await page.addStyleTag({ content: "body { height: calc(100% - 78px); margin-top: 78px; } #recording-caption { position: fixed; inset: 0 0 auto; height: 78px; z-index: 100; background: #202027; color: white; padding: 10px 24px; font: 600 23px/1.35 system-ui; letter-spacing: 0; } #recording-caption small { display: block; color: #bdbdc7; font: 12px/1.5 system-ui; }" });
      const caption = async (text) => page.evaluate((text) => {
        let el = document.getElementById("recording-caption");
        if (!el) { el = document.createElement("div"); el.id = "recording-caption"; document.body.append(el); }
        const small = document.createElement("small");
        small.textContent = "Quire | Scripted demo, real editing session | No model calls";
        el.replaceChildren(document.createTextNode(text), small);
      }, text);
      const selectEnd = async () => {
        await page.evaluate(() => { const view = window.__quireView; view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true }); view.focus(); });
      };
      await agent.connect();
      await page.locator("#attr-btn").click();
      await caption(name.startsWith("01") ? "Keep writing while your agent edits." : name.startsWith("02") ? "An agent suggestion is not a committed edit." : "Remove the agent's additions. Keep your own.");
      recording = true;
      const started = Date.now();
      capture = (async () => {
        while (recording) {
          await page.screenshot({ path: join(frames, `f${String(frame++).padStart(4, "0")}.png`) });
          await pause(125);
        }
      })();
      await pause(1400);
      if (name.startsWith("01")) {
        await selectEnd();
        const typing = page.keyboard.type("Human note: Keep requests idempotent.\n", { delay: 95 });
        const at = agent.text.toString().indexOf("## Requirements");
        const addition = "Agent note: Retry transient errors only.\n\n";
        for (let i = 0; i < addition.length; i++) {
          insertAttributed(agent.text, at + i, addition[i], author);
          agent.announce({ anchor: at + i + 1, head: at + i + 1 });
          await pause(85);
        }
        await typing;
        await expect(page.locator("#preview")).toContainText("Human note: Keep requests idempotent.");
        await expect(page.locator("#preview")).toContainText("Agent note: Retry transient errors only.");
        await caption("Both contributions. One local Markdown file.");
      } else if (name.startsWith("02")) {
        const original = "Retry limit: 3 attempts.";
        const propose = (replacement, id) => {
          const at = agent.text.toString().indexOf(original);
          proposeDelete(agent.text, at, at + original.length, author, id);
          insertAttributed(agent.text, at + original.length, replacement, author, { suggestion: id });
        };
        propose("Retry limit: unlimited attempts.", "unsafe-demo");
        await expect(page.locator("#suggestions")).toContainText("unlimited attempts");
        if ((await readFile(join(root, path), "utf8")).includes("unlimited")) throw new Error("Proposal reached disk");
        await caption("Reject a change that weakens the requirement.");
        await pause(2600);
        await page.locator("#suggestions").getByRole("button", { name: "Reject", exact: true }).click();
        await expect(page.locator("#suggestions .card")).toHaveCount(0);
        await pause(1200);
        await agent.settle();
        propose("Retry limit: 3 attempts with exponential backoff.", "safe-demo");
        await expect(page.locator("#suggestions")).toContainText("exponential backoff");
        await caption("Accept the useful revision. You decide.");
        await pause(2400);
        await page.locator("#suggestions").getByRole("button", { name: "Accept", exact: true }).click();
        await expect.poll(() => readFile(join(root, path), "utf8")).toContain("exponential backoff");
      } else {
        await selectEnd();
        await page.keyboard.type("Human note: Keep this requirement.\n", { delay: 65 });
        await agent.settle();
        insertAttributed(agent.text, agent.text.length, "\nAgent note: Add a separate metrics dashboard.\n", author);
        await expect(page.locator("#preview")).toContainText("separate metrics dashboard");
        await pause(2500);
        await page.locator("#agents button.revert").click();
        await expect(page.locator("#preview")).not.toContainText("separate metrics dashboard");
        await expect(page.locator("#preview")).toContainText("Human note: Keep this requirement.");
        await caption("Agent-added text removed. Human text preserved.");
      }
      await pause(2200);
      await page.screenshot({ path: join(out, `${name}.png`) });
      recording = false;
      await capture;
      await writeFile(join(frames, "meta.json"), JSON.stringify({ frames: frame, fps: frame / ((Date.now() - started) / 1000), width: 1440, height: 900 }));
      const encoded = spawnSync(process.execPath, [join(import.meta.dirname, "encode.mjs")], {
        stdio: "inherit", env: { ...process.env, FRAMES: frames, OUT: join(out, `${name}.gif`), SCALE: "1.25", COLORS: "64" },
      });
      if (encoded.status !== 0) throw new Error(`Encoding failed: ${name}`);
    } finally {
      recording = false;
      await capture;
      agent.close();
      await context.close();
    }
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
