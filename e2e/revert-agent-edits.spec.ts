import { expect, test, type Page } from "@playwright/test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { insertAttributed, registerAuthor } from "@quire/bridge";
import { QuireServer } from "@quire/server";

let root: string;
let server: QuireServer;
let base: string;
const agent = { id: "revert-demo-agent", name: "Test Agent", color: "#2f9e44", kind: "agent" as const };

test.beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "quire-revert-ui-"));
  await writeFile(join(root, "doc.md"), "# Work\n\nHuman text.\n");
  server = await QuireServer.start({ root, port: 0, git: false, webRoot: resolve("packages/web/dist") });
  base = `http://127.0.0.1:${server.port}`;
});
test.afterAll(async () => { await server?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function openWithAgentText(page: Page, path: string): Promise<void> {
  await writeFile(join(root, path), "# Work\n\nHuman text.\n");
  await expect.poll(() => server.vault.list().includes(path)).toBe(true);
  await page.goto(`${base}/?doc=${path}`);
  await expect(page.locator(".status-text")).toHaveText("live");
  const handle = server.vault.getDoc(path);
  registerAuthor(handle.doc, agent);
  insertAttributed(handle.text, handle.text.length, "Agent contribution.\n", agent);
  await expect(page.locator(".cm-content")).toContainText("Agent contribution.");
}

async function confirmRevert(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Revert Test Agent's edits" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: /Your name/ }).fill("Heet");
  await dialog.getByRole("button", { name: "Revert edits" }).click();
}

test("a collaborator sees a revert and can restore it without reloading", async ({ page, browser }) => {
  await openWithAgentText(page, "peer.md");
  const context = await browser.newContext();
  const teammate = await context.newPage();
  await teammate.goto(`${base}/?doc=peer.md`);
  await expect(teammate.locator(".cm-content")).toContainText("Agent contribution.");

  await confirmRevert(page);

  await expect(teammate.locator(".cm-content")).not.toContainText("Agent contribution.");
  // The text vanishing with no explanation or way back is what makes revert frightening.
  await expect(teammate.locator(".revert-history")).toContainText("Heet (self-reported)");
  await expect(teammate.locator(".revert-history").getByRole("button", { name: "Restore" })).toBeVisible();
  await context.close();
});

test("an uncertain save still exposes Restore and says what to check", async ({ page }) => {
  await openWithAgentText(page, "uncertain.md");
  // The edit lands, then saving it fails: the one case where a person most needs the way back.
  await page.route("**/api/reverts*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fetch();
    await route.fulfill({
      status: 500, contentType: "application/json",
      body: JSON.stringify({ error: "Action may have applied but could not be saved. Refresh and inspect the document before retrying." }),
    });
  });

  await confirmRevert(page);

  await expect(page.locator(".revert-notice")).toContainText("may have applied");
  await expect(page.locator(".revert-history").getByRole("button", { name: "Restore" })).toBeVisible();
  // Unlike a toast it stays until the person has dealt with it.
  await page.waitForTimeout(6500);
  await expect(page.locator(".revert-notice")).toBeVisible();
});

test("a proxy error is reported as unconfirmed, not as a parse failure", async ({ page }) => {
  await openWithAgentText(page, "gateway.md");
  // Remote teams reach Quire through a tunnel, which answers with HTML when the host is away.
  await page.route("**/api/reverts*", async (route) => {
    if (route.request().method() !== "POST") return route.fallback();
    await route.fulfill({ status: 502, contentType: "text/html", body: "<html>Bad gateway</html>" });
  });

  await confirmRevert(page);

  await expect(page.locator(".revert-notice")).toContainText("could not be confirmed");
  await expect(page.locator(".toast")).toHaveCount(0);
});

test("revert asks for an actor, records it, and restores after reload", async ({ page }) => {
  await page.goto(`${base}/?doc=doc.md`);
  await expect(page.locator(".status-text")).toHaveText("live");
  const handle = server.vault.getDoc("doc.md");
  registerAuthor(handle.doc, agent);
  insertAttributed(handle.text, handle.text.length, "Agent contribution.\n", agent);
  await expect(page.locator(".cm-content")).toContainText("Agent contribution.");
  await page.getByRole("button", { name: "Revert Test Agent's edits" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("self-reported");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.locator(".cm-content")).toContainText("Agent contribution.");
  await page.getByRole("button", { name: "Revert Test Agent's edits" }).click();
  await dialog.getByRole("textbox", { name: /Your name/ }).fill("Heet");
  await dialog.getByRole("button", { name: "Revert edits" }).click();
  await expect(page.locator(".cm-content")).not.toContainText("Agent contribution.");
  await expect(page.locator(".revert-history")).toContainText("Heet (self-reported)");
  await page.reload();
  await expect(page.locator(".revert-history")).toContainText("Heet (self-reported)");
  await page.locator(".revert-history").getByRole("button", { name: "Restore" }).click();
  await dialog.getByRole("textbox", { name: /Your name/ }).fill("Arun");
  await dialog.getByRole("button", { name: "Restore edits" }).click();
  await expect(page.locator(".cm-content")).toContainText("Agent contribution.");
  await expect(page.locator(".revert-history")).toContainText("Restored by Arun");
});
