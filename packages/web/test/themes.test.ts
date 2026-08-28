import { describe, expect, it } from "vitest";
import { DEFAULT_DARK, DEFAULT_LIGHT, THEMES, contrast, themeById } from "../src/themes.js";

/**
 * Every theme must be readable.
 *
 * Published palettes are designed for syntax highlighting, where the lowest greys are
 * comments nobody has to read. Quire uses those same roles for prose people do read, so a
 * straight mapping leaves secondary text under-contrast — Nord's nord3 on nord0 is 1.69:1,
 * and an audit of the first sixteen themes found 33 failures across 15 of them.
 *
 * applyTheme corrects the text-bearing roles at runtime. This mirrors that correction and
 * asserts the result, so adding a colourway cannot quietly ship an unreadable one.
 */

const parse = (hex: string): [number, number, number] =>
  [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (rgb: number[]): string =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;
const mix = (a: string, b: string, t: number): string =>
  toHex([0, 1, 2].map((i) => parse(a)[i]! + (parse(b)[i]! - parse(a)[i]!) * t));

/** The same blend applyTheme performs. */
function legible(colour: string, against: string, toward: string, target: number): string {
  if (contrast(colour, against) >= target) return colour;
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(colour, toward, step / 20);
    if (contrast(candidate, against) >= target) return candidate;
  }
  return toward;
}

describe("every theme is legible", () => {
  for (const theme of THEMES) {
    it(`${theme.name} meets contrast on every text role`, () => {
      const c = theme.colors;
      const muted = legible(legible(c.muted, c.overlay, c.text, 3.2), c.base, c.text, 3.2);
      const subtle = legible(c.subtle, c.base, c.text, 4.6);
      const accentText = legible(c.iris, c.base, c.text, 4.0);
      const agentText = legible(c.gold, c.surface, c.text, 3.6);

      // Body text, on both grounds it appears against.
      expect(contrast(c.text, c.base)).toBeGreaterThanOrEqual(7);
      expect(contrast(c.text, c.surface)).toBeGreaterThanOrEqual(6.5);

      // Secondary text: read, not merely perceived.
      expect(contrast(subtle, c.base)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(subtle, c.overlay)).toBeGreaterThanOrEqual(3.5);

      // Lowest-emphasis text still has to be readable in the sidebar and rail.
      expect(contrast(muted, c.base)).toBeGreaterThanOrEqual(3);
      expect(contrast(muted, c.overlay)).toBeGreaterThanOrEqual(3);

      // The two places an accent carries text rather than painting a mark.
      expect(contrast(accentText, c.base)).toBeGreaterThanOrEqual(3.9);
      expect(contrast(agentText, c.surface)).toBeGreaterThanOrEqual(3.5);
    });
  }
});

describe("the registry is coherent", () => {
  it("offers enough choice, with both classics", () => {
    expect(THEMES.length).toBeGreaterThanOrEqual(12);
    expect(themeById("light")?.name).toBe("Classic Light");
    expect(themeById("dark")?.name).toBe("Classic Dark");
  });

  it("has unique ids and names", () => {
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(new Set(THEMES.map((t) => t.name)).size).toBe(THEMES.length);
  });

  it("defines all twelve roles as hex colours in every theme", () => {
    const roles = ["base", "surface", "overlay", "muted", "subtle", "text",
                   "love", "gold", "rose", "pine", "foam", "iris"] as const;
    for (const theme of THEMES) {
      for (const role of roles) {
        expect(theme.colors[role], `${theme.id}.${role}`).toMatch(/^#[0-9a-f]{6}$/i);
      }
    }
  });

  it("names defaults that exist, one of each mode", () => {
    expect(themeById(DEFAULT_LIGHT)?.mode).toBe("light");
    expect(themeById(DEFAULT_DARK)?.mode).toBe("dark");
  });

  it("offers a real choice in both modes", () => {
    expect(THEMES.filter((t) => t.mode === "light").length).toBeGreaterThanOrEqual(4);
    expect(THEMES.filter((t) => t.mode === "dark").length).toBeGreaterThanOrEqual(8);
  });

  it("distinguishes grounds within a theme", () => {
    // base, surface and overlay must actually differ, or depth collapses.
    for (const t of THEMES) {
      expect(new Set([t.colors.base, t.colors.surface, t.colors.overlay]).size, t.id).toBe(3);
    }
  });
});
