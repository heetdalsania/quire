import { expect, test } from "@playwright/test";

test("the disposable demo loads, edits, previews, and persists", async ({ page, request, browserName }) => {
  const files = await request.get("/api/files");
  await expect(files).toBeOK();
  await expect(files.json()).resolves.toMatchObject({
    files: expect.arrayContaining(["architecture.md", "project-plan.md", "welcome.md"]),
  });

  const documents: Record<string, { path: string; heading: string }> = {
    chromium: { path: "welcome.md", heading: "Welcome to Quire" },
    firefox: { path: "project-plan.md", heading: "Launch plan" },
    webkit: { path: "architecture.md", heading: "Architecture" },
  };
  const selected = documents[browserName];
  const marker = `Edited in ${browserName}.`;

  await page.goto(`/?doc=${encodeURIComponent(selected.path)}`);
  await expect(page.getByText("live", { exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole("heading", { name: selected.heading })).toBeVisible();

  const editor = page.getByRole("textbox");
  await editor.click();
  await editor.press(process.platform === "darwin" ? "Meta+End" : "Control+End");
  await editor.press("End");
  await editor.type(`\n\n${marker}`);

  await expect(page.getByRole("article")).toContainText(marker);
  await page.reload();
  await expect(page.getByRole("textbox")).toContainText(marker);
});
