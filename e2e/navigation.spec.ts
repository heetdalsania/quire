import { expect, test } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QuireServer } from "@quire/server";

let root: string;
let server: QuireServer;
let base: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-navigation-"));
  await mkdir(join(root, "Workshop", "Session 1"), { recursive: true });
  await mkdir(join(root, "Other"));
  await writeFile(join(root, "home.md"), "# Home\n\nA content-only needle.\n");
  await writeFile(join(root, "Workshop", "Session 1", "Agenda.md"), "# Workshop agenda\n\nEdit this together.\n\n## Before we start\n\n- [ ] Introduce yourself\n- [ ] Choose a topic\n- [ ] Review the shared notes\n\n## Discussion\n\nWhat should we explore next?\n");
  await writeFile(join(root, "Other", "Agenda.md"), "# Another agenda\n");
  server = await QuireServer.start({ root, port: 0, git: false, persist: false,
    webRoot: resolve("packages/web/dist"), registryPath: resolve("registry/index.json"), githubSearch: false });
  base = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("folders collapse, reveal nested documents, and search paths and contents", async ({ page }) => {
  await page.goto(`${base}/?doc=home.md`);
  const files = page.locator("#files");
  await files.locator('summary').filter({ hasText: "Workshop" }).click();
  await files.locator('summary').filter({ hasText: "Session 1" }).click();
  await files.getByRole("button", { name: "Agenda.md", exact: true }).click();
  await expect(page.locator("#docpath")).toHaveText("Workshop/Session 1/Agenda.md");
  await expect(page.locator("#preview")).toContainText("Workshop agenda");
  await page.screenshot({ path: test.info().outputPath("desktop-folders.png") });
  await files.locator('summary').filter({ hasText: "Workshop" }).click();
  await expect(files.getByRole("button", { name: "Agenda.md", exact: true })).toBeHidden();
  await page.locator("#search").fill("agenda.MD");
  await expect(files.getByRole("button")).toHaveCount(2);
  await page.locator("#search").fill("workshop/session 1");
  await expect(files.getByRole("button")).toHaveCount(1);
  await expect(files).toContainText("Agenda.md");
  await page.locator("#search").fill("content-only needle");
  await expect(files.getByRole("button")).toHaveCount(1);
  await expect(files).toContainText("home.md");
  await page.locator("#search").fill("no-such-match");
  await expect(files).toContainText("No matching documents");
  await page.locator("#search").fill("");
  await expect(files.locator('summary').filter({ hasText: "Workshop" })).toBeVisible();
  await expect(files.locator('details').filter({ has: page.locator('summary[title="Workshop"]') }).first()).not.toHaveAttribute("open", "");
  await writeFile(join(root, "new-file.md"), "# New file\n");
  await expect(files.getByRole("button", { name: "new-file.md", exact: true })).toBeVisible();
  await expect(files.getByRole("button", { name: "Agenda.md", exact: true })).toBeHidden();
});

test("Discover and vault navigation remain reachable on a phone", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?doc=home.md`);
  const nav = page.getByRole("navigation", { name: "Workspace views" });
  await nav.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("tab", { name: "Discover", exact: true }).click();
  await expect(page.locator("#discover")).toBeVisible();
  await expect(page.locator("#gallery .gallery-card").first()).toBeVisible();
  await nav.getByRole("button", { name: "Files", exact: true }).click();
  await page.getByRole("tab", { name: "Vault", exact: true }).click();
  await expect(page.locator("#files")).toBeVisible();
  await nav.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator(".cm-content")).toContainText("Home");
  await expect(page.locator("#snapshot-btn")).toBeHidden();
});

test("desktop view controls can hide either pane and restore the split", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${base}/?doc=home.md`);
  const modes = page.getByRole("group", { name: "Document view" });
  await modes.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(page.locator("#preview")).toBeHidden();
  await expect(page.locator("#editor")).toBeVisible();
  await modes.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#preview")).toBeVisible();
  await modes.getByRole("button", { name: "Split", exact: true }).click();
  await expect(page.locator("#editor")).toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
});

test("an old content search cannot replace a cleared file tree", async ({ page }) => {
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requested = new Promise<void>((resolve) => { started = resolve; });
  await page.route("**/api/search?*", async (route) => {
    started();
    await gate;
    await route.fulfill({ json: { results: [{ path: "home.md", line: 3, text: "needle" }] } });
  });
  await page.goto(`${base}/?doc=home.md`);
  await page.locator("#search").fill("needle");
  await requested;
  await page.locator("#search").fill("");
  const response = page.waitForResponse((r) => r.url().includes("/api/search?"));
  release();
  await response;
  await expect(page.locator("#files summary").filter({ hasText: "Workshop" })).toBeVisible();
});

test("phone navigation keeps files, editing, preview and comments reachable", async ({ page, browserName }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${base}/?doc=home.md`);
  const nav = page.getByRole("navigation", { name: "Workspace views" });
  await expect(nav).toBeVisible();
  await expect(page.locator("#editor")).toBeVisible();
  await nav.getByRole("button", { name: "Files", exact: true }).click();
  await expect(page.locator("#sidebar")).toBeVisible();
  await page.locator("#search").fill("Workshop/Session 1");
  await page.locator('#files button[title="Workshop/Session 1/Agenda.md"]').click();
  const editor = page.locator(".cm-content");
  await expect(editor).toContainText("Workshop agenda");
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  const marker = `Phone edit in ${browserName}`;
  await editor.press("End");
  await editor.pressSequentially(`\n\n${marker}`);
  await nav.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.locator("#editor")).toBeHidden();
  await expect(page.locator("#preview")).toBeVisible();
  await expect(page.locator("#preview")).toContainText(marker);
  await page.screenshot({ path: test.info().outputPath("phone-preview.png") });
  await expect.poll(() => readFile(join(root, "Workshop", "Session 1", "Agenda.md"), "utf8")).toContain(marker);
  await nav.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(page.locator("#rail")).toBeVisible();
  await nav.getByRole("button", { name: "Edit", exact: true }).click();
  await expect(editor).toContainText(marker);
  for (const size of [{ width: 320, height: 568 }, { width: 844, height: 390 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(size);
    await expect(nav).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
    const box = await page.locator("#editor").boundingBox();
    expect(box!.width).toBeGreaterThan(size.width - 10);
    expect(box!.height).toBeGreaterThan(180);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(nav).toBeHidden();
  await expect(page.locator("#sidebar")).toBeVisible();
  await expect(page.locator("#preview")).toBeVisible();
  await expect(editor).toBeVisible();
});

test("touch navigation and saved desktop preferences do not hide mobile controls", async ({ browser, browserName }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true,
    ...(browserName === "firefox" ? {} : { isMobile: true }) });
  const page = await context.newPage();
  try {
    await page.addInitScript(() => {
      localStorage.setItem("quire:layout", JSON.stringify({ sidebarOpen: false, railOpen: false, editorOpen: false, editor: 800 }));
      localStorage.setItem("quire:display", JSON.stringify({ focusMode: true }));
    });
    await page.goto(`${base}/?doc=home.md`);
    const nav = page.getByRole("navigation", { name: "Workspace views" });
    await nav.getByRole("button", { name: "Files", exact: true }).tap();
    await expect(page.locator("#sidebar")).toBeVisible();
    await nav.getByRole("button", { name: "Preview", exact: true }).tap();
    await expect(page.locator("#preview")).toContainText("Home");
    await nav.getByRole("button", { name: "Edit", exact: true }).tap();
    const editor = page.locator(".cm-content");
    await expect(editor).toBeVisible();
    await editor.click();
    await editor.press(process.platform === "darwin" ? "Meta+Home" : "Control+Home");
    await editor.press("Home");
    await editor.press("Shift+End");
    await page.getByRole("button", { name: "Comment on selection" }).tap();
    await expect(page.locator("#rail")).toBeVisible();
    await page.getByPlaceholder("What needs saying?").fill("Workshop feedback");
    await page.locator(".composer").getByRole("button", { name: "Comment", exact: true }).tap();
    await expect(page.locator("#comments")).toContainText("Workshop feedback");
    await page.screenshot({ path: test.info().outputPath("phone-comments.png") });
  } finally {
    await context.close();
  }
});
