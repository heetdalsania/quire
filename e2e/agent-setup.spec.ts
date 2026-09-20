import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QuireServer } from "@quire/server";
import { AgentSession } from "@quire/mcp";
import { insertAttributed } from "@quire/bridge";

let root: string;
let server: QuireServer;
let base: string;
const path = "计划.md";
test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-setup-test-"));
  await writeFile(join(root, path), "# 计划\n\nHello 世界 🌍\n");
  server = await QuireServer.start({ root, port: 0, git: false, persist: false, webRoot: resolve("packages/web/dist") });
  base = `http://127.0.0.1:${server.port}`;
});
test.afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });

test("setup reflects real agent presence, platform configuration and keyboard dismissal", async ({ page }) => {
  await page.goto(`${base}/?doc=${encodeURIComponent(path)}`);
  await expect(page.locator(".status-text")).toHaveText("live");
  await page.locator("#connect-agent").click();
  const dialog = page.getByRole("dialog");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+s" : "Control+Shift+s");
  await expect(page.locator("#suggest-btn")).toHaveAttribute("aria-pressed", "false");
  await expect(dialog.getByLabel("Configuration", { exact: true })).toHaveValue(new RegExp(base));
  await dialog.getByLabel("Client", { exact: true }).selectOption("cursor");
  await dialog.getByLabel("Platform", { exact: true }).selectOption("windows");
  expect(JSON.parse(await dialog.getByLabel("Configuration", { exact: true }).inputValue()).mcpServers.quire.command).toBe("cmd");
  await expect(dialog.getByLabel("Sample task")).toHaveValue(/计划.md/);
  await expect(page.locator("#agent-connection-status")).toHaveText("No agent in this document");
  const agent = new AgentSession(base, path, { id: "setup-agent", name: "Test Agent", kind: "agent", color: "#2f9e44" });
  try {
    await agent.connect();
    await expect(page.locator("#agent-connection-status")).toContainText("Agent connected: Test Agent");
  } finally { agent.close(); }
  await expect(page.locator("#agent-connection-status")).toHaveText("No agent in this document");
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page.locator("#connect-agent")).toBeFocused();
});

test("multilingual human input survives undo, redo, language switches and disk persistence", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?doc=${encodeURIComponent(path)}`);
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Hello 世界");
  const marker = `中文输入 café 👩🏽‍💻 ${browserName}`;
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await editor.press("End");
  await page.keyboard.insertText(`\n${marker}\n`);
  await expect(page.locator("#preview")).toContainText(marker);
  await editor.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  await expect(editor).not.toContainText(marker);
  // Physical keys let Shift produce the same uppercase event as a real keyboard.
  await editor.press(process.platform === "darwin" ? "Meta+Shift+KeyZ" : "Control+Shift+KeyZ");
  await expect(editor).toContainText(marker);
  await page.locator("#interface-language").selectOption("zh-CN");
  await expect(editor).toContainText(marker);
  await page.locator("#interface-language").selectOption("en");
  await expect.poll(() => readFile(join(root, path), "utf8")).toContain(marker);
  await page.reload();
  await expect(editor).toContainText(marker);
});

test("Chinese navigation persists without translating content, and suggestions remain reviewable", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?doc=${encodeURIComponent(path)}`);
  await expect(page.locator(".cm-content")).toContainText("Hello 世界");
  const before = await readFile(join(root, path), "utf8");
  await page.locator("#interface-language").selectOption("zh-CN");
  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator("#connect-agent")).toHaveText("连接智能体");
  await expect(page.locator("#mode-vault")).toHaveText("文档库");
  expect(await readFile(join(root, path), "utf8")).toBe(before);
  await page.reload();
  await expect(page.locator("#interface-language")).toHaveValue("zh-CN");
  const agent = new AgentSession(base, path, { id: "language-agent", name: "Reviewer", kind: "agent", color: "#2f9e44" });
  try {
    await agent.connect();
    insertAttributed(agent.text, agent.text.length, "\n建议：保留原文。\n", { id: "language-agent", name: "Reviewer", kind: "agent", color: "#2f9e44" }, { suggestion: "language-test" });
    await expect(page.locator("#suggestions")).toContainText("建议：保留原文。");
    expect(await readFile(join(root, path), "utf8")).toBe(before);
    await page.locator("#suggestions").getByRole("button", { name: "拒绝" }).click();
    await expect(page.locator("#suggestions")).not.toContainText("建议：保留原文。");
  } finally { agent.close(); }
  await page.screenshot({ path: test.info().outputPath("chinese-desktop.png") });
  await page.setViewportSize({ width: 320, height: 568 });
  await page.locator('#compact-nav [data-panel="sidebar"]').click();
  await page.locator("#connect-agent").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  await page.screenshot({ path: test.info().outputPath("chinese-phone-setup.png") });
});

test("Linux undo shortcuts preserve the initial document and concurrent agent contributions", async ({ page, browserName }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "Linux x86_64" }));
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?doc=${encodeURIComponent(path)}`);
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Hello 世界");
  const undo = "Control+z";
  await editor.click();
  await editor.press(undo);
  await expect(editor).toContainText("Hello 世界");
  await editor.press("Control+End");
  await editor.press("End");
  const human = `Human addition ${browserName}`;
  const remote = `Agent addition ${browserName}`;
  await page.keyboard.insertText(`\n${human}\n`);
  await expect(editor).toContainText(human);
  const author = { id: `undo-agent-${browserName}`, name: "Peer", kind: "agent" as const, color: "#2f9e44" };
  const agent = new AgentSession(base, path, author);
  try {
    await agent.connect();
    insertAttributed(agent.text, agent.text.length, `\n${remote}\n`, author);
    await expect(editor).toContainText(remote);
    for (const redo of ["Control+y", "Control+Shift+KeyZ"]) {
      await editor.press(undo);
      await expect(editor).not.toContainText(human);
      await expect(editor).toContainText(remote);
      await expect(editor).toContainText("Hello 世界");
      await editor.press(redo);
      await expect(editor).toContainText(human);
      await expect(editor).toContainText(remote);
    }
  } finally { agent.close(); }
});

test("shared links cannot produce full-vault setup commands", async ({ page, request }) => {
  const response = await request.post(`${base}/api/share?role=view&path=${encodeURIComponent(path)}`);
  const { token } = await response.json();
  await page.goto(`${base}/?share=${token}&doc=${encodeURIComponent(path)}`);
  await page.locator("#connect-agent").click();
  await expect(page.getByRole("dialog")).toContainText("Localhost session required");
  await expect(page.getByLabel("Configuration", { exact: true })).toHaveCount(0);
});
