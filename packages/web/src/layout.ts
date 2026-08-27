/**
 * Panel sizing and collapsing.
 *
 * Three column widths are stored as CSS custom properties so a drag is a single style
 * write rather than a re-layout in JavaScript, and so the whole arrangement can be
 * restored by setting three values at boot.
 *
 * Sizes persist per browser. Like the display settings, none of this touches a file.
 */

export interface Layout {
  sidebar: number;
  rail: number;
  /** Editor width inside the split, in px. Null means "share the space evenly". */
  editor: number | null;
  sidebarOpen: boolean;
  railOpen: boolean;
}

export const LAYOUT_DEFAULTS: Layout = {
  sidebar: 258,
  rail: 312,
  editor: null,
  sidebarOpen: true,
  railOpen: true,
};

const KEY = "quire:layout";
const LIMITS = {
  sidebar: { min: 190, max: 460 },
  rail: { min: 240, max: 520 },
  editor: { min: 260, max: Infinity },
};

let layout: Layout = { ...LAYOUT_DEFAULTS };

export const getLayout = (): Layout => layout;

export function loadLayout(): Layout {
  try {
    const raw = localStorage.getItem(KEY);
    layout = raw ? { ...LAYOUT_DEFAULTS, ...(JSON.parse(raw) as Partial<Layout>) } : { ...LAYOUT_DEFAULTS };
  } catch {
    layout = { ...LAYOUT_DEFAULTS };
  }
  return layout;
}

function persist(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(layout));
  } catch {
    // Private browsing; the layout simply resets next time.
  }
}

export function applyLayout(): void {
  const root = document.documentElement;
  root.style.setProperty("--sidebar-w", `${layout.sidebar}px`);
  root.style.setProperty("--rail-w", `${layout.rail}px`);
  root.style.setProperty("--editor-w", layout.editor === null ? "1fr" : `${layout.editor}px`);
  document.body.classList.toggle("sidebar-closed", !layout.sidebarOpen);
  document.body.classList.toggle("rail-closed", !layout.railOpen);
}

export function togglePanel(which: "sidebar" | "rail"): boolean {
  const key = which === "sidebar" ? "sidebarOpen" : "railOpen";
  layout = { ...layout, [key]: !layout[key] };
  applyLayout();
  persist();
  return layout[key];
}

const clamp = (n: number, min: number, max: number): number => Math.min(max, Math.max(min, n));

/**
 * Wire a drag handle.
 *
 * Pointer capture keeps the drag alive when the cursor outruns the 5px handle, which it
 * always does; without it a fast drag drops on the first frame the pointer leaves.
 */
export function wireResizer(
  handle: HTMLElement,
  which: "sidebar" | "rail" | "editor",
  container?: HTMLElement,
): void {
  const measure = (clientX: number): number => {
    if (which === "sidebar") return clientX;
    if (which === "rail") return window.innerWidth - clientX;
    const box = (container ?? document.body).getBoundingClientRect();
    return clientX - box.left;
  };

  const apply = (value: number): void => {
    const limits = LIMITS[which];
    const max =
      which === "editor" && container
        ? Math.max(limits.min, container.getBoundingClientRect().width - 260)
        : limits.max;
    layout = { ...layout, [which]: clamp(value, limits.min, max) };
    applyLayout();
  };

  handle.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    // Capture keeps the drag alive when the cursor outruns the 5px handle, which it
    // always does. Listen on the window regardless: capture is unavailable for some
    // synthetic and assistive pointer sources, and losing the drag there is worse than
    // the small cost of two extra listeners.
    try {
      handle.setPointerCapture(event.pointerId);
    } catch {
      // Not capturable; the window listeners below carry the drag.
    }
    handle.classList.add("dragging");
    document.body.classList.add("resizing");

    const onMove = (move: PointerEvent): void => apply(measure(move.clientX));
    const onUp = (): void => {
      handle.classList.remove("dragging");
      document.body.classList.remove("resizing");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      persist();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  });

  // Double-click restores the default, which is faster than dragging back by eye.
  handle.addEventListener("dblclick", () => {
    layout = { ...layout, [which]: LAYOUT_DEFAULTS[which] };
    applyLayout();
    persist();
  });

  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 40 : 12;
    const current = which === "editor"
      ? (layout.editor ?? (container?.getBoundingClientRect().width ?? 800) / 2)
      : layout[which];
    if (event.key === "ArrowLeft") { event.preventDefault(); apply(current - (which === "rail" ? -step : step)); }
    else if (event.key === "ArrowRight") { event.preventDefault(); apply(current + (which === "rail" ? -step : step)); }
    else return;
    persist();
  });
}
