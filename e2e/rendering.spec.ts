import { expect, test } from "@playwright/test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { QuireServer } from "@quire/server";

let root: string;
let server: QuireServer;
let base: string;

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-rendering-"));
  await writeFile(join(root, "format.md"), '# Formatting\n\n| Feature | Status |\n| --- | --- |\n| Preview | Ready |\n\n- [x] Tested\n\n[[other|Open notes]]\n\n```mermaid\nflowchart LR\n  A[Human] --> B[Agent]\n```\n');
  await writeFile(join(root, "other.md"), "# Other notes\n");
  await writeFile(join(root, "unsafe.md"), '# Untrusted HTML\n\n<img src="/missing-image" onerror="window.__unsafeExecuted=true">\n\n<a href="javascript:window.__unsafeExecuted=true">Unsafe link</a>\n\n<script>window.__unsafeExecuted=true</script>\n\n<style>body{display:none}</style>\n\n<iframe srcdoc="<script>parent.__unsafeExecuted=true</script>"></iframe>\n');
  await writeFile(join(root, "broken.md"), "# Broken diagram\n\n```mermaid\nnot-a-diagram\n```\n\nStill readable.\n");
  server = await QuireServer.start({ root, port: 0, git: false, persist: false,
    webRoot: resolve("packages/web/dist"), githubSearch: false });
  base = `http://127.0.0.1:${server.port}`;
});

test.afterAll(async () => {
  await server?.close();
  if (root) await rm(root, { recursive: true, force: true });
});

test("Markdown tables, tasks, wiki links and lazy-loaded Mermaid survive upgrades", async ({ page }) => {
  await page.goto(`${base}/?doc=format.md`);
  const preview = page.locator("#preview");
  await expect(preview.locator("table")).toContainText("Ready");
  await expect(preview.getByRole("checkbox")).toBeChecked();
  const diagram = preview.locator(".mermaid-figure svg");
  await expect(diagram).toBeVisible();
  expect((await diagram.boundingBox())?.width).toBeGreaterThan(20);
  await expect(diagram).toContainText("Human");
  await expect(preview.locator(".mermaid-error")).toHaveCount(0);
  await preview.getByRole("link", { name: "Open notes" }).click();
  await expect(page.locator("#docpath")).toHaveText("other.md");
});

test("untrusted Markdown cannot execute scripts or inject active HTML", async ({ page }) => {
  await page.goto(`${base}/?doc=unsafe.md`);
  const preview = page.locator("#preview");
  await expect(preview).toContainText("Untrusted HTML");
  await expect(preview.locator("script, iframe, style, [onerror], a[href^='javascript:']")).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).__unsafeExecuted)).toBeUndefined();
  const downloaded = page.waitForEvent("download");
  await page.locator("#export-btn").click();
  await page.getByRole("button", { name: "HTML self-contained" }).click();
  const html = await readFile((await (await downloaded).path())!, "utf8");
  expect(html).not.toContain("__unsafeExecuted");
  expect(html).not.toContain("<iframe");
});

test("a malformed diagram leaves the rest of the document readable", async ({ page }) => {
  await page.goto(`${base}/?doc=broken.md`);
  await expect(page.locator("#preview .mermaid-error")).toBeVisible();
  await expect(page.locator("#preview")).toContainText("Still readable.");
});
