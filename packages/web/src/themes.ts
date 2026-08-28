/**
 * Colourways.
 *
 * Every theme supplies the same twelve roles, so the entire interface — including the
 * authorship tinting and the suggestion diffs, which are the parts that must stay legible —
 * follows from one small table rather than from per-theme overrides scattered through the
 * stylesheet.
 *
 * Where a theme is somebody's published palette, the real values are used rather than an
 * approximation. Half-remembered hexes are what makes a "Nord theme" look like an
 * off-brand Nord.
 */

export type ThemeMode = "light" | "dark";

export interface ThemeColors {
  /** Page ground. */
  base: string;
  /** Raised surfaces: cards, the printed pane. */
  surface: string;
  /** Sunken surfaces: sidebars, rails. */
  overlay: string;
  /** Lowest-emphasis text. */
  muted: string;
  /** Secondary text. */
  subtle: string;
  /** Body text. */
  text: string;
  /** Deletions and refusals. */
  love: string;
  /** Agents. */
  gold: string;
  /** Warnings and orphans. */
  rose: string;
  /** Insertions and acceptance. */
  pine: string;
  /** Presence and connection. */
  foam: string;
  /** The accent: links, focus, selection. */
  iris: string;
}

export interface Theme {
  id: string;
  name: string;
  mode: ThemeMode;
  /** A short note shown in the picker. */
  note: string;
  colors: ThemeColors;
}

export const THEMES: Theme[] = [
  {
    id: "paper",
    name: "Paper",
    mode: "light",
    note: "Warm paper and ink. The default.",
    colors: {
      base: "#faf4ed", surface: "#fffaf3", overlay: "#f2e9e1",
      muted: "#9893a5", subtle: "#797593", text: "#464261",
      love: "#b4637a", gold: "#ea9d34", rose: "#d7827e",
      pine: "#286983", foam: "#56949f", iris: "#907aa9",
    },
  },
  {
    id: "ink",
    name: "Ink",
    mode: "dark",
    note: "The same palette after dark.",
    colors: {
      base: "#232136", surface: "#2a273f", overlay: "#393552",
      muted: "#6e6a86", subtle: "#908caa", text: "#e0def4",
      love: "#eb6f92", gold: "#f6c177", rose: "#ea9a97",
      pine: "#3e8fb0", foam: "#9ccfd8", iris: "#c4a7e7",
    },
  },
  {
    id: "light",
    name: "Classic Light",
    mode: "light",
    note: "Neutral greys, no tint.",
    colors: {
      base: "#ffffff", surface: "#fbfbfc", overlay: "#f1f2f4",
      muted: "#9ba1a9", subtle: "#61676e", text: "#1c1f23",
      love: "#c53030", gold: "#b7791f", rose: "#c05621",
      pine: "#2b6cb0", foam: "#2c7a7b", iris: "#4c51bf",
    },
  },
  {
    id: "dark",
    name: "Classic Dark",
    mode: "dark",
    note: "Neutral greys, no tint.",
    colors: {
      base: "#141517", surface: "#1c1e21", overlay: "#26292d",
      muted: "#70757c", subtle: "#a8aeb6", text: "#e8eaed",
      love: "#f27272", gold: "#e0b341", rose: "#e89563",
      pine: "#6aa9e9", foam: "#5ec8c8", iris: "#9b9bf0",
    },
  },
  {
    id: "nord",
    name: "Nord",
    mode: "dark",
    note: "Arctic, muted, blue-grey.",
    colors: {
      base: "#2e3440", surface: "#3b4252", overlay: "#434c5e",
      muted: "#4c566a", subtle: "#d8dee9", text: "#eceff4",
      love: "#bf616a", gold: "#ebcb8b", rose: "#d08770",
      pine: "#a3be8c", foam: "#88c0d0", iris: "#b48ead",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    mode: "dark",
    note: "Retro, warm, high contrast.",
    colors: {
      base: "#282828", surface: "#32302f", overlay: "#3c3836",
      muted: "#7c6f64", subtle: "#bdae93", text: "#ebdbb2",
      love: "#fb4934", gold: "#fabd2f", rose: "#fe8019",
      pine: "#b8bb26", foam: "#8ec07c", iris: "#d3869b",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    mode: "light",
    note: "Schoonover's calibrated classic.",
    colors: {
      base: "#fdf6e3", surface: "#fffbf0", overlay: "#eee8d5",
      muted: "#93a1a1", subtle: "#657b83", text: "#073642",
      love: "#dc322f", gold: "#b58900", rose: "#cb4b16",
      pine: "#859900", foam: "#2aa198", iris: "#6c71c4",
    },
  },
  {
    id: "solarized-dark",
    name: "Solarized Dark",
    mode: "dark",
    note: "The same, inverted.",
    colors: {
      base: "#002b36", surface: "#073642", overlay: "#0a4451",
      muted: "#586e75", subtle: "#93a1a1", text: "#eee8d5",
      love: "#dc322f", gold: "#b58900", rose: "#cb4b16",
      pine: "#859900", foam: "#2aa198", iris: "#6c71c4",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    mode: "dark",
    note: "Purple, vivid, unmistakable.",
    colors: {
      base: "#282a36", surface: "#343746", overlay: "#44475a",
      muted: "#6272a4", subtle: "#bfc7d5", text: "#f8f8f2",
      love: "#ff5555", gold: "#f1fa8c", rose: "#ffb86c",
      pine: "#50fa7b", foam: "#8be9fd", iris: "#bd93f9",
    },
  },
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    mode: "dark",
    note: "Neon on deep blue.",
    colors: {
      base: "#1a1b26", surface: "#1f2335", overlay: "#292e42",
      muted: "#565f89", subtle: "#9aa5ce", text: "#c0caf5",
      love: "#f7768e", gold: "#e0af68", rose: "#ff9e64",
      pine: "#9ece6a", foam: "#7dcfff", iris: "#bb9af7",
    },
  },
  {
    id: "catppuccin-mocha",
    name: "Catppuccin Mocha",
    mode: "dark",
    note: "Soft pastels, low glare.",
    colors: {
      base: "#1e1e2e", surface: "#313244", overlay: "#45475a",
      muted: "#6c7086", subtle: "#a6adc8", text: "#cdd6f4",
      love: "#f38ba8", gold: "#f9e2af", rose: "#fab387",
      pine: "#a6e3a1", foam: "#94e2d5", iris: "#cba6f7",
    },
  },
  {
    id: "catppuccin-latte",
    name: "Catppuccin Latte",
    mode: "light",
    note: "The pastel palette by daylight.",
    colors: {
      base: "#eff1f5", surface: "#ffffff", overlay: "#e6e9ef",
      muted: "#9ca0b0", subtle: "#6c6f85", text: "#4c4f69",
      love: "#d20f39", gold: "#df8e1d", rose: "#fe640b",
      pine: "#40a02b", foam: "#179299", iris: "#8839ef",
    },
  },
  {
    id: "everforest",
    name: "Everforest",
    mode: "dark",
    note: "Green, soft, easy on the eyes.",
    colors: {
      base: "#232a2e", surface: "#2d353b", overlay: "#343f44",
      muted: "#859289", subtle: "#9da9a0", text: "#d3c6aa",
      love: "#e67e80", gold: "#dbbc7f", rose: "#e69875",
      pine: "#a7c080", foam: "#83c092", iris: "#d699b6",
    },
  },
  {
    id: "monokai",
    name: "Monokai",
    mode: "dark",
    note: "The vivid classic.",
    colors: {
      base: "#272822", surface: "#31322c", overlay: "#3e3d32",
      muted: "#75715e", subtle: "#c8c8b8", text: "#f8f8f2",
      love: "#f92672", gold: "#e6db74", rose: "#fd971f",
      pine: "#a6e22e", foam: "#66d9ef", iris: "#ae81ff",
    },
  },
  {
    id: "terminal",
    name: "Terminal",
    mode: "dark",
    note: "Phosphor green. Maximum contrast.",
    colors: {
      base: "#0a0f0a", surface: "#0f170f", overlay: "#16211a",
      muted: "#3f6b46", subtle: "#5fbf6a", text: "#8cf29a",
      love: "#ff5f56", gold: "#ffd866", rose: "#ffa657",
      pine: "#3ddc84", foam: "#5ff2c8", iris: "#7ee787",
    },
  },
  {
    id: "sepia",
    name: "Sepia",
    mode: "light",
    note: "Old book. Long reading.",
    colors: {
      base: "#f4ecd8", surface: "#fbf5e6", overlay: "#e8dcc0",
      muted: "#a1917a", subtle: "#7a6a53", text: "#3b3228",
      love: "#a13d3d", gold: "#a97b28", rose: "#b5642f",
      pine: "#5a7247", foam: "#3f7d78", iris: "#6b5b95",
    },
  },
];

export const DEFAULT_LIGHT = "paper";
export const DEFAULT_DARK = "ink";

export const themeById = (id: string): Theme | undefined => THEMES.find((t) => t.id === id);

// ── legibility ─────────────────────────────────────────────────────────────────
//
// Published palettes are designed for syntax highlighting, where the lowest greys are
// comments nobody has to read. Quire uses those same roles for text people *do* read --
// empty states, hints, file paths -- and mapping them straight across leaves secondary
// text under-contrast. Nord's nord3 on nord0 is 1.69:1.
//
// Rather than editing other people's palettes, the text-bearing roles are nudged toward
// the foreground until they are legible. Accents keep their published values, because
// those are what make a theme recognisable.

const parse = (hex: string): [number, number, number] => [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
const toHex = (rgb: [number, number, number]): string =>
  `#${rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("")}`;

const luminance = (hex: string): number => {
  const channels = parse(hex).map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
};

export function contrast(a: string, b: string): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high! + 0.05) / (low! + 0.05);
}

const mix = (a: string, b: string, t: number): string => {
  const [x, y] = [parse(a), parse(b)];
  return toHex([0, 1, 2].map((i) => x[i]! + (y[i]! - x[i]!) * t) as [number, number, number]);
};

/**
 * Blend `colour` toward `toward` until it reads clearly against `against`.
 *
 * Returns the original when it already passes, so a theme that was designed properly is
 * left exactly as its author intended.
 */
function legible(colour: string, against: string, toward: string, target: number): string {
  if (contrast(colour, against) >= target) return colour;
  for (let step = 1; step <= 20; step++) {
    const candidate = mix(colour, toward, step / 20);
    if (contrast(candidate, against) >= target) return candidate;
  }
  return toward;
}

/**
 * Resolve the theme to paint, given a preference.
 *
 * "system" is not a theme but a rule: follow the operating system, which is what most
 * people actually want and the only setting that changes with the time of day.
 */
export function resolveTheme(preference: string): Theme {
  if (preference !== "system") {
    const chosen = themeById(preference);
    if (chosen) return chosen;
  }
  const prefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
  return themeById(prefersDark ? DEFAULT_DARK : DEFAULT_LIGHT) ?? THEMES[0]!;
}

/**
 * Paint a theme.
 *
 * Only the twelve roles are written; every other token in the stylesheet is derived from
 * them with color-mix, so a new palette needs no CSS at all. `color-scheme` is set too, so
 * scrollbars, form controls and the browser's own chrome follow along.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement;
  const c = theme.colors;
  for (const [role, value] of Object.entries(c)) {
    root.style.setProperty(`--${role}`, value);
  }

  // Text-bearing roles are corrected against the ground they actually sit on. `muted` is
  // used in the sidebar and rail, which are painted with `overlay`, so that is the harder
  // of its two grounds and the one worth solving for.
  root.style.setProperty("--muted", legible(legible(c.muted, c.overlay, c.text, 3.2), c.base, c.text, 3.2));
  root.style.setProperty("--subtle", legible(c.subtle, c.base, c.text, 4.6));

  // Accents keep their published values as marks and backgrounds, but the two places they
  // carry text -- wiki-links and star counts -- get a corrected variant.
  root.style.setProperty("--accent-text", legible(c.iris, c.base, c.text, 4.0));
  root.style.setProperty("--agent-text", legible(c.gold, c.surface, c.text, 3.6));

  const dark = theme.mode === "dark";
  root.style.setProperty("--rule", `color-mix(in srgb, var(--text) ${dark ? 14 : 11}%, transparent)`);
  root.style.setProperty("--rule-soft", `color-mix(in srgb, var(--text) ${dark ? 8 : 6}%, transparent)`);
  root.style.setProperty(
    "--shadow-sm",
    dark ? "0 1px 2px rgb(0 0 0 / 0.28)" : "0 1px 2px color-mix(in srgb, var(--text) 7%, transparent)",
  );
  root.style.setProperty(
    "--shadow-md",
    dark
      ? "0 1px 2px rgb(0 0 0 / 0.3), 0 8px 20px -8px rgb(0 0 0 / 0.5)"
      : "0 1px 2px color-mix(in srgb, var(--text) 6%, transparent), 0 6px 16px -6px color-mix(in srgb, var(--text) 14%, transparent)",
  );

  root.style.colorScheme = theme.mode;
  root.dataset.themeId = theme.id;
  root.dataset.mode = theme.mode;

  const meta = document.querySelector('meta[name="theme-color"]:not([media])')
    ?? Object.assign(document.createElement("meta"), { name: "theme-color" });
  meta.setAttribute("content", theme.colors.base);
  if (!meta.parentElement) document.head.append(meta);
}
