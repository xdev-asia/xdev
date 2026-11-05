import { ICONS } from "@xdev-asia/ui";

export interface CopyLabels {
  copy: string;
  copied: string;
}

/** How long the "Copied" state shows, in ms. */
export const COPIED_MS = 1500;

type Part = readonly [string, Record<string, unknown>];
const svg = (name: "copy" | "check"): string => {
  const parts = (ICONS[name] as readonly Part[]).map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([k, v]) => `${k}="${String(v)}"`).join(" ")}/>`);
  return `<svg class="x-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${parts.join("")}</svg>`;
};

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The button markup for one code block. */
export function copyButtonHtml(labels: CopyLabels): string {
  return `<button type="button" class="ws-icon-btn md-code-copy" aria-label="${esc(labels.copy)}" title="${esc(labels.copy)}">${svg("copy")}</button>`;
}

interface Block {
  querySelector(selector: string): unknown;
  insertAdjacentHTML(where: "beforeend", html: string): void;
}

/** Adds a copy button to each code block under `root` that has none yet. */
export function fillCodeCopy(root: { querySelectorAll(selector: string): ArrayLike<Block> }, labels: CopyLabels): void {
  for (const block of Array.from(root.querySelectorAll("pre.md-code"))) {
    if (!block.querySelector("button.md-code-copy")) block.insertAdjacentHTML("beforeend", copyButtonHtml(labels));
  }
}

interface ButtonLike {
  closest(selector: string): { querySelector(selector: string): { textContent: string | null } | null } | null;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  innerHTML: string;
}

/**
 * Copies the raw text of the code block holding `button`, then shows "Copied" until `later` fires.
 * A failed write leaves the button as it was.
 */
export async function copyCode(
  button: ButtonLike,
  deps: { write: (text: string) => Promise<void>; later: (fn: () => void, ms: number) => void; labels: CopyLabels },
): Promise<void> {
  const code = button.closest("pre")?.querySelector("code");
  if (!code) return;
  try {
    await deps.write(code.textContent ?? "");
  } catch {
    return;
  }
  const show = (label: string, icon: "copy" | "check"): void => {
    button.setAttribute("aria-label", label);
    button.setAttribute("title", label);
    if (icon === "check") button.setAttribute("data-copied", "true");
    else button.removeAttribute("data-copied");
    button.innerHTML = svg(icon);
  };
  show(deps.labels.copied, "check");
  deps.later(() => show(deps.labels.copy, "copy"), COPIED_MS);
}
