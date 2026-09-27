import { expect, test } from "@playwright/test";
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
