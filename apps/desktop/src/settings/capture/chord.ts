import type { Platform } from "@/platform";

export const DEFAULT_CAPTURE_SHORTCUT = "CmdOrCtrl+Alt+Shift+S";

const GLYPHS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Cmd: "⌘" };
const ORDER = ["CmdOrCtrl", "Ctrl", "Alt", "Shift"];

/**
 * A chord the recorder took ("Ctrl+Alt+Shift+S", "Alt+Shift+Cmd+S") as a global shortcut
 * accelerator: the platform's main modifier becomes `CmdOrCtrl`, so the setting moves between machines.
 */
export function toAccelerator(chord: string, p: Platform): string {
  const parts = chord.split("+");
  const key = parts.pop() ?? "";
  const main = p === "mac" ? "Cmd" : "Ctrl";
  const mods = parts.map((m) => (m === main ? "CmdOrCtrl" : m));
  return [...ORDER.filter((m) => mods.includes(m)), key].join("+");
}

/** The accelerator as shown to a person: "Ctrl+Alt+Shift+S", or "⌘⌥⇧S" on macOS. */
export function acceleratorLabel(accelerator: string, p: Platform): string {
  const parts = accelerator.split("+").map((part) => (part === "CmdOrCtrl" ? (p === "mac" ? "Cmd" : "Ctrl") : part));
  if (p !== "mac") return parts.join("+");
  const key = parts.pop() ?? "";
  const mods = ["Ctrl", "Alt", "Shift", "Cmd"].filter((m) => parts.includes(m));
  return [...mods.map((m) => GLYPHS[m]), key].join("");
}
