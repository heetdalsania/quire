/**
 * Reading and writing preferences.
 *
 * Agents do not care what typeface a document is set in, but people spend hours in one.
 * These settings change only how the document is *displayed* -- never a byte of the file --
 * so two people can read the same document at comfortable settings without disagreeing
 * about its contents.
 *
 * Stored per browser; nothing is synced or uploaded.
 */

export interface DisplaySettings {
  proseFont: "serif" | "sans" | "mono";
  editorFont: "mono" | "sans" | "serif";
  fontSize: number;
  lineHeight: number;
  measure: number;
  theme: "system" | "light" | "dark";
  focusMode: boolean;
}

export const DEFAULTS: DisplaySettings = {
  proseFont: "serif",
  editorFont: "mono",
  fontSize: 16.5,
  lineHeight: 1.72,
  measure: 62,
  theme: "system",
  focusMode: false,
};

const KEY = "quire:display";

const STACKS = {
  serif: '"Iowan Old Style","Palatino Linotype",Palatino,Charter,"Source Serif 4",Georgia,serif',
  sans: 'ui-sans-serif,-apple-system,"SF Pro Text","Segoe UI",Inter,system-ui,sans-serif',
  mono: 'ui-monospace,"SF Mono","JetBrains Mono",Menlo,Consolas,monospace',
} as const;

export function loadSettings(): DisplaySettings {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULTS, ...(JSON.parse(raw) as Partial<DisplaySettings>) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(settings: DisplaySettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Private browsing; settings simply do not persist.
  }
}

export function applySettings(settings: DisplaySettings): void {
  const root = document.documentElement;
  root.style.setProperty("--prose-font", STACKS[settings.proseFont]);
  root.style.setProperty("--editor-font", STACKS[settings.editorFont]);
  root.style.setProperty("--prose-size", `${settings.fontSize}px`);
  root.style.setProperty("--prose-leading", String(settings.lineHeight));
  root.style.setProperty("--prose-measure", `${settings.measure}ch`);
  // Keep the source pane a little tighter than the printed pane; monospace reads large.
  root.style.setProperty("--editor-size", `${Math.max(11, settings.fontSize - 3)}px`);

  root.dataset.theme = settings.theme;
  document.body.classList.toggle("focus-mode", settings.focusMode);
}
