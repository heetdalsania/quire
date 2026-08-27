/**
 * Toolbar popovers.
 *
 * Built as plain DOM rather than a component framework because each one is small, and
 * because a menu that closes on outside-click and Escape is the entire requirement.
 */

let open: HTMLElement | null = null;

export function closeMenu(): void {
  open?.remove();
  open = null;
}

export function openMenu(anchor: HTMLElement, build: (panel: HTMLElement) => void): void {
  const wasOpen = open?.dataset.owner === anchor.id;
  closeMenu();
  if (wasOpen) return;

  const panel = document.createElement("div");
  panel.className = "popover";
  panel.dataset.owner = anchor.id;
  build(panel);
  document.body.append(panel);
  open = panel;

  // Anchor to the button, then pull back inside the viewport if it would overflow.
  const rect = anchor.getBoundingClientRect();
  panel.style.top = `${rect.bottom + 8}px`;
  panel.style.right = `${Math.max(12, window.innerWidth - rect.right)}px`;

  const dismiss = (event: MouseEvent): void => {
    if (!panel.contains(event.target as Node) && event.target !== anchor) {
      closeMenu();
      document.removeEventListener("mousedown", dismiss);
    }
  };
  setTimeout(() => document.addEventListener("mousedown", dismiss), 0);
  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeMenu();
  });
}

export function heading(text: string): HTMLElement {
  const h = document.createElement("h3");
  h.textContent = text;
  return h;
}

export function menuItem(label: string, hint: string, onClick: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.className = "menu-item";
  button.textContent = label;
  if (hint) {
    const small = document.createElement("small");
    small.textContent = hint;
    button.append(small);
  }
  button.onclick = () => {
    closeMenu();
    onClick();
  };
  return button;
}

export function segmented<T extends string>(
  options: Array<{ value: T; label: string }>,
  current: T,
  onPick: (value: T) => void,
): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "seg";
  for (const option of options) {
    const button = document.createElement("button");
    button.textContent = option.label;
    button.setAttribute("aria-pressed", String(option.value === current));
    button.onclick = () => {
      for (const sibling of wrap.children) sibling.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-pressed", "true");
      onPick(option.value);
    };
    wrap.append(button);
  }
  return wrap;
}

export function slider(
  label: string,
  value: number,
  range: { min: number; max: number; step: number; suffix?: string },
  onInput: (value: number) => void,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "row";
  const name = document.createElement("label");
  name.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(range.min);
  input.max = String(range.max);
  input.step = String(range.step);
  input.value = String(value);
  const out = document.createElement("output");
  out.textContent = `${value}${range.suffix ?? ""}`;
  input.oninput = () => {
    const next = Number(input.value);
    out.textContent = `${next}${range.suffix ?? ""}`;
    onInput(next);
  };
  row.append(name, input, out);
  return row;
}

export function row(label: string, control: HTMLElement): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "row";
  const name = document.createElement("label");
  name.textContent = label;
  wrap.append(name, control);
  return wrap;
}

export function hint(text: string): HTMLElement {
  const p = document.createElement("p");
  p.className = "hint";
  p.textContent = text;
  return p;
}
