import type { Api, RestoreMode } from "@/api";
import type { FileTabs } from "@/files/fileTabs";
import { LAYOUT_VERSION, type RestoreReport, type SessionFallback } from "./layoutSnapshot";
import type { Sessions } from "./sessions";

/** How long after the last change the layout is written. */
export const SAVE_DEBOUNCE_MS = 1000;

export interface LayoutSaver {
  /** Writes the layout now, if a change is waiting (or `force`). */
  flush(force?: boolean): void;
  stop(): void;
}

/**
 * Saves `sessions.snapshot()` through `layoutSave` one second after the last change, and at once on
 * `flush` (the window closing). Start it only after the restore, or a snapshot of nothing would
 * replace the one waiting to be restored.
 */
export function startLayoutSave(api: Pick<Api, "layoutSave">, sessions: Sessions, debounceMs = SAVE_DEBOUNCE_MS): LayoutSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = () => {
    timer = null;
    // A write that fails (disk full, say) is not worth a dialog; the next change tries again.
    api.layoutSave(sessions.snapshot()).catch(() => {});
  };
  // Layout changes and tab changes both emit; a change of nothing the snapshot keeps is written too,
  // which is cheap (one small file) and keeps this free of a comparison.
  const off = sessions.subscribe(() => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, debounceMs);
  });
  return {
    flush(force = false) {
      if (timer === null && !force) return;
      if (timer !== null) clearTimeout(timer);
      write();
    },
    stop() {
      off();
      if (timer !== null) clearTimeout(timer);
      timer = null;
    },
  };
}

/** The fallback of `Sessions.restore`: the newest resumable session of the worktree that started after the tab. */
export function sessionFallback(api: Pick<Api, "agentSessions">): SessionFallback {
  return async (worktree, cli, since) => {
    if (!cli) return null;
    const rows = await api.agentSessions(
      { text: null, scope: { kind: "worktree", path: worktree }, agent: cli, homeId: null, sort: "firstDesc", limit: 5 },
      false,
    );
    return rows.find((r) => r.resumable && r.session.first >= since)?.session.id ?? null;
  };
}

export interface LayoutRestore {
  mode: RestoreMode;
  report: RestoreReport;
}

/**
 * Loads the saved layout and restores it once. Resolves to null when there is nothing to restore or
 * the mode is `none`; never rejects (a broken store starts the app with no tabs).
 */
export async function restoreLayout(
  api: Pick<Api, "layoutLoad" | "uiSettingsGet" | "agentSessions">,
  sessions: Sessions,
  known: (worktree: string) => boolean,
  openFile: (worktree: string, rel: string) => Promise<boolean>,
): Promise<LayoutRestore | null> {
  try {
    const [snapshot, ui] = await Promise.all([api.layoutLoad(), api.uiSettingsGet()]);
    if (!snapshot || snapshot.version !== LAYOUT_VERSION || ui.restore === "none") return null;
    const report = await sessions.restore(snapshot, ui.restore, sessionFallback(api), { known, openFile });
    return { mode: ui.restore, report };
  } catch {
    return null;
  }
}

/** Closes exactly the tabs a restore opened, in one go. */
export async function undoRestore(sessions: Sessions, opened: string[]): Promise<void> {
  await Promise.all(opened.map((id) => sessions.close(id)));
}

/** `RestoreOptions.openFile` over the file-tab store: the file is read once; a file that is gone is not opened. */
export function openRestoredFile(api: Pick<Api, "fileRead">, store: FileTabs): (worktree: string, rel: string) => Promise<boolean> {
  return async (worktree, rel) => {
    try {
      const file = await api.fileRead(worktree, rel);
      store.open(worktree, rel);
      store.loaded(worktree, rel, file);
      return true;
    } catch {
      return false;
    }
  };
}
