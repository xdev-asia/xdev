import type { Api, CliTerminal } from "@/api";
import { terminalBytes } from "@/quickCommands/run";
import { paneOf, removeTab, splitPane } from "./paneTree";
import type { Sessions } from "./sessions";

export interface CliTerminalHost {
  sessions: Pick<Sessions, "open" | "close" | "tab" | "layout" | "setLayout">;
  /** Makes sure the worktree's tabs are mounted, so a tab opened there gets its pty. */
  ensureMounted?(worktree: string): void;
}

/** The default shell when it is on, else the first one; null with no shell. */
export async function defaultShell(api: Pick<Api, "profiles">): Promise<string | null> {
  const pv = await api.profiles();
  return (pv.shells.some((s) => s.id === pv.defaultShell) ? pv.defaultShell : pv.shells[0]?.id) ?? null;
}

/**
 * Does what one `cli://terminal` asks. Create and split open a shell tab with the backend's id, which
 * waits for it in the tab report; a split puts it in a new pane beside the source tab's pane.
 */
export async function runCliTerminal(api: Pick<Api, "profiles">, host: CliTerminalHost, e: CliTerminal): Promise<void> {
  const { sessions } = host;
  if (e.op === "close") {
    if (sessions.tab(e.id)) await sessions.close(e.id);
    return;
  }
  if (sessions.tab(e.id)) return;
  const shell = await defaultShell(api);
  if (!shell) return;
  host.ensureMounted?.(e.worktree);
  const tab = sessions.open(e.worktree, shell, null, undefined, {
    id: e.id,
    ...(e.title ? { title: e.title } : {}),
    ...(e.cwd ? { dir: e.cwd } : {}),
  });
  if (e.op === "split" && e.source && e.dir) {
    const layout = sessions.layout(e.worktree);
    const pane = layout && paneOf(layout, e.source);
    const without = layout && pane ? removeTab(layout, e.id) : null;
    if (pane && without) sessions.setLayout(e.worktree, splitPane(without, pane, e.dir, e.id));
  }
  // A tab that is not on screen has no pty yet; the command waits for it.
  if (e.cmd) tab.client.typeWhenReady(terminalBytes(e.cmd, true));
}

/** Follows `cli://terminal` until the returned stop is called. */
export function startCliTerminal(api: Pick<Api, "profiles" | "onCliTerminal">, host: CliTerminalHost): () => void {
  const off = api.onCliTerminal((e) => void runCliTerminal(api, host, e).catch(() => {}));
  return () => void off.then((stop) => stop()).catch(() => {});
}
