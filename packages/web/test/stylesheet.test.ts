import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/style.css"), "utf8");

/**
 * A custom property that is used but never defined does not warn — it makes the whole
 * declaration invalid at computed-value time, and the browser silently drops it.
 *
 * When the layout variables were accidentally deleted, `grid-template-columns` became
 * invalid and the grid fell back to auto-placement. The vault still looked plausible, so
 * it went unnoticed; Discover collapsed entirely. Nothing in the test suite could see it,
 * because nothing renders CSS. This can.
 */
describe("the stylesheet defines what it uses", () => {
  // Strip usages first: `var(--x)` contains `--x` and would otherwise read as a
  // definition. Declarations are also packed several to a line, so anchoring to the start
  // of a line would only ever find the first of each.
  const declarations = css.replace(/var\([^)]*\)/g, "");
  const defined = new Set([...declarations.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]!));

  it("defines every custom property used without a fallback", () => {
    const missing = new Set<string>();
    for (const [, name, rest] of css.matchAll(/var\(\s*(--[\w-]+)\s*([^)]*)\)/g)) {
      // `var(--x, fallback)` degrades gracefully; a bare `var(--x)` does not.
      if (rest!.trim().startsWith(",")) continue;
      if (!defined.has(name!)) missing.add(name!);
    }
    expect([...missing]).toEqual([]);
  });

  it("still defines the layout variables the grid depends on", () => {
    for (const name of ["--sidebar-w", "--rail-w", "--rz-w", "--sidebar-rz", "--rail-rz"]) {
      expect(defined.has(name), `${name} is undefined`).toBe(true);
    }
  });

  it("gives every grid child of body an explicit column", () => {
    // Auto-placement is what let #rail take the main column when the sidebar was hidden.
    for (const selector of ["#sidebar", "main", "#rail", "#rz-sidebar", "#rz-rail", "#discover"]) {
      const block = css.match(new RegExp(`${selector.replace("#", "#")}[^{]*\\{[^}]*\\}`, "g"))?.join("") ?? "";
      expect(block, `${selector} has no grid-column`).toMatch(/grid-column:/);
    }
  });
});
