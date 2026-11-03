// The X-1 toast: a terminal had focus and an app shortcut took the key, so say where it went.

import { pushToast } from "@/workspace/toastStore";
import { getBindingsState } from "./bindingsStore";
import type { ActionId } from "./keymap";

export interface TerminalKeyHost {
  t(key: string, vars?: Record<string, string | number>): string;
  /** Opens Settings › Shortcuts with the list narrowed to `action`. */
  openShortcuts(action: ActionId): void;
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

/** Tests only. */
export function resetTerminalKeyForTests(): void {
  host = null;
  told.clear();
}
