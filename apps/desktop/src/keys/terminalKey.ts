// The X-1 toast: a terminal had focus and an app shortcut took the key, so say where it went.

import { pushToast } from "@/workspace/toastStore";
import { getBindingsState, subscribeBindings } from "./bindingsStore";
import type { ActionId } from "./keymap";

export interface TerminalKeyHost {
  t(key: string, vars?: Record<string, string | number>): string;
  /** Opens Settings › Shortcuts with the list narrowed to `action`. */
  openShortcuts(action?: ActionId): void;
}

let host: TerminalKeyHost | null = null;
const told = new Set<ActionId>();

/** The workspace says how to word the toast and where its button goes; null when it unmounts. */
export function setTerminalKeyHost(next: TerminalKeyHost | null): void {
  host = next;
}

/**
 * "Terminal shortcut handled: {title} ({chord})", once per action per app run, and not at all when
 * the hint setting is off.
 */
export function notifyTerminalKey(action: ActionId, chord: string | null): void {
  if (!host || !getBindingsState().keySettings.terminalHints || told.has(action)) return;
  told.add(action);
  const { t, openShortcuts } = host;
  pushToast({
    id: `terminal-key:${action}`,
    text: t("keys.terminalHandled", { title: t(`keys.action.${action}`), chord: chord ?? "" }),
    actions: [{ label: t("keys.openShortcuts"), run: () => openShortcuts(action) }],
  });
}

/**
 * A toast when `keybindings.json` cannot be read, or when its keys collide. Other findings (an
 * unknown action, a bad chord) show on the Shortcuts page only. One toast per change of the file's
 * findings, so a settings change does not repeat it. Returns the unsubscribe.
 */
export function startDiagnosticToasts(): () => void {
  let shown = "";
  const check = () => {
    const found = getBindingsState().diagnostics;
    const parse = found.find((d) => d.kind === "parse");
    const conflicts = found.filter((d) => d.kind === "conflict");
    const signature = JSON.stringify([parse?.message ?? null, conflicts.map((d) => d.message)]);
    if (signature === shown) return;
    shown = signature;
    if (!host || (!parse && conflicts.length === 0)) return;
    const { t, openShortcuts } = host;
    pushToast({
      id: "keybindings-file",
      text: parse ? t("keys.fileError", { message: parse.message }) : t("keys.fileConflicts", { count: conflicts.length }),
      actions: [{ label: t("keys.openShortcuts"), run: () => openShortcuts() }],
      ttlMs: 12000,
    });
  };
  check();
  return subscribeBindings(check);
}

/** Tests only. */
export function resetTerminalKeyForTests(): void {
  host = null;
  told.clear();
}
