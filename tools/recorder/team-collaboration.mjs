import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium, expect } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { QuireServer } from "../../packages/server/dist/src/index.js";
import { AgentSession } from "../../packages/mcp/dist/src/index.js";
import { insertAttributed } from "../../packages/bridge/dist/src/index.js";

const out = resolve(process.env.OUT_DIR ?? join(import.meta.dirname, "output"));
const root = await mkdtemp(join(tmpdir(), "quire-team-demo-"));
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const plan = "# Launch plan\n\nTwo teammates are planning a small API beta.\n\n## Contract\n\nRequests have stable IDs.\n\n## Rollout\n\nRelease to a small test group.\n\n## Human review\n\n";
const progress = "# Sprint progress\n\n## Task board\n\n| ID | Owner | Status |\n| --- | --- | --- |\n| A01 | Backend A | In progress |\n| B01 | Backend B | Not started |\n| F01 | Frontend | In progress |\n\n## Iteration log\n\n2026-09-22 09:00 | Backend A | Schema agreed; validation tests passed.\n";
const authors = [
  { id: "demo-backend-a", name: "Backend A", color: "#bd782a", kind: "agent" },
  { id: "demo-backend-b", name: "Backend B", color: "#087f8c", kind: "agent" },
];

await mkdir(out, { recursive: true });
await writeFile(join(root, "team-plan.md"), plan);
await writeFile(join(root, "sprint-progress.md"), progress);
let server;
let browser;

async function setupPage(base, path) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 }, colorScheme: "light" });
  const page = await context.newPage();
  await page.goto(`${base}/?doc=${path}`);
  await expect(page.locator(".status-text")).toHaveText("live");
  await page.addStyleTag({ content: "body { height: calc(100% - 70px); margin-top: 70px; } #demo-caption { position: fixed; inset: 0 0 auto; height: 70px; z-index: 100; background: #202027; color: white; padding: 8px 22px; font: 600 21px/1.3 system-ui; letter-spacing: 0; } #demo-caption small { display: block; color: #c9c9d2; font: 12px/1.5 system-ui; }" });
  return { context, page };
}

async function caption(page, title, note = "Synthetic documents · scripted inputs · real Quire sessions · no model calls") {
  await page.evaluate(({ title, note }) => {
    let element = document.getElementById("demo-caption");
    if (!element) { element = document.createElement("div"); element.id = "demo-caption"; document.body.append(element); }
    const small = document.createElement("small");
    small.textContent = note;
    element.replaceChildren(document.createTextNode(title), small);
  }, { title, note });
}

async function selectEnd(page) {
  await page.evaluate(() => {
    const view = window.__quireView;
    view.dispatch({ selection: { anchor: view.state.doc.length }, scrollIntoView: true });
    view.focus();
  });
}

async function record(page, name, action) {
  const frames = join(out, `${name}-frames`);
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  let recording = true;
  let frame = 0;
  const started = Date.now();
  const capture = (async () => {
    while (recording) {
      await page.screenshot({ path: join(frames, `f${String(frame++).padStart(4, "0")}.png`) });
      await pause(125);
    }
  })();
  try {
    await action();
    await pause(1000);
    await page.screenshot({ path: join(out, `${name}.png`) });
  } finally {
    recording = false;
    await capture;
  }
  await writeFile(join(frames, "meta.json"), JSON.stringify({ frames: frame, fps: frame / ((Date.now() - started) / 1000) }));
  const encoded = spawnSync(process.execPath, [join(import.meta.dirname, "encode.mjs")], {
    stdio: "inherit", env: { ...process.env, FRAMES: frames, OUT: join(out, `${name}.gif`), SCALE: "1.3333", COLORS: "48" },
  });
  if (encoded.status !== 0) throw new Error(`GIF encoding failed: ${name}`);
}

async function typeAgent(session, author, heading, line) {
  const at = session.text.toString().indexOf(heading) + heading.length;
  if (at < heading.length) throw new Error(`Missing heading: ${heading}`);
  for (let i = 0; i < line.length; i++) {
    insertAttributed(session.text, at + i, line[i], author);
    session.announce({ anchor: at + i + 1, head: at + i + 1 });
    await pause(45);
  }
}

try {
  server = await QuireServer.start({ root, port: 0, git: false, persist: false,
    webRoot: resolve("packages/web/dist"), appendOnlyLogs: ["sprint-progress.md"] });
  const base = `http://127.0.0.1:${server.port}`;
  browser = await chromium.launch();

  const primary = await setupPage(base, "team-plan.md");
  const peer = await setupPage(base, "team-plan.md");
  const agents = authors.map((author) => new AgentSession(base, "team-plan.md", author));
  try {
    await Promise.all(agents.map((agent) => agent.connect()));
    await caption(primary.page, "Two teammates and two agents, one Markdown file.");
    await record(primary.page, "quire-team-live", async () => {
      await pause(900);
      await selectEnd(primary.page);
      await primary.page.keyboard.type("Owner: Ship the smallest useful beta.\n", { delay: 45 });
      await caption(primary.page, "Changes from other sessions appear as you type.");
      await selectEnd(peer.page);
      await peer.page.keyboard.type("Reviewer: Keep failure cases visible.\n", { delay: 45 });
      await typeAgent(agents[0], authors[0], "## Contract\n\n", "Agent A: Validate each request ID.\n");
      await agents[0].settle();
      await typeAgent(agents[1], authors[1], "## Rollout\n\n", "Agent B: Retry transient failures only.\n");
      await expect.poll(() => readFile(join(root, "team-plan.md"), "utf8")).toContain("Agent B: Retry transient failures only.");
      await expect(primary.page.locator("#preview")).toContainText("Reviewer: Keep failure cases visible.");
      await primary.page.locator("#attr-btn").click();
      await caption(primary.page, "Every contribution stays in the local .md file.");
      await pause(1500);
    });
  } finally {
    for (const agent of agents) agent.close();
    await peer.context.close();
    await primary.context.close();
  }

  const board = await setupPage(base, "sprint-progress.md");
  const transport = new StdioClientTransport({ command: process.execPath,
    args: ["packages/mcp/bin/quire-mcp.js", "--url", base, "--name", "Backend B", "--role", "editor"], stderr: "pipe" });
  const client = new Client({ name: "team-demo", version: "1.0.0" });
  const previewNote = "Development preview · synthetic documents · real Quire sessions · no model calls";
  try {
    await client.connect(transport);
    await caption(board.page, "Task status and evidence live beside the work.", previewNote);
    await record(board.page, "quire-team-progress", async () => {
      await pause(1000);
      const edit = await client.callTool({ name: "edit_document", arguments: {
        path: "sprint-progress.md", old_text: "| B01 | Backend B | Not started |", new_text: "| B01 | Backend B | In progress |",
      } });
      if (edit.isError) throw new Error(JSON.stringify(edit.content));
      await caption(board.page, "An agent appends a dated iteration record.", previewNote);
      await pause(800);
      const entry = "2026-09-22 09:15 | Backend B | Retry policy drafted; focused tests passed.\n";
      const append = await client.callTool({ name: "append_document", arguments: { path: "sprint-progress.md", text: entry } });
      if (append.isError) throw new Error(JSON.stringify(append.content));
      await expect.poll(() => readFile(join(root, "sprint-progress.md"), "utf8")).toContain(entry.trim());
      await pause(1300);
      await caption(board.page, "An attempted rewrite of an older entry is refused.", previewNote);
      const denied = await client.callTool({ name: "edit_document", arguments: {
        path: "sprint-progress.md", old_text: "2026-09-22 09:00 | Backend A | Schema agreed; validation tests passed.",
        new_text: "2026-09-22 09:00 | Backend A | overwritten",
      } });
      if (!denied.isError) throw new Error("Append-only guard did not refuse the rewrite");
      const disk = await readFile(join(root, "sprint-progress.md"), "utf8");
      if (!disk.includes("Schema agreed; validation tests passed.") || disk.includes("overwritten")) throw new Error("Earlier entry changed on disk");
      await pause(1800);
    });
  } finally {
    await client.close();
    await transport.close();
    await board.context.close();
  }
} finally {
  await browser?.close();
  await server?.close();
  await rm(root, { recursive: true, force: true });
}
