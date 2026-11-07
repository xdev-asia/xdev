import type { Api, RestoreMode } from "@/api";
import type { FileTabs } from "@/files/fileTabs";
import { subscribeBrowserTabs } from "@/browser/browserTabs";
import { LAYOUT_VERSION, type RestoreOptions, type RestoreReport, type SessionFallback } from "./layoutSnapshot";
import type { Sessions } from "./sessions";
import { markStartup } from "@/startup/startupSteps";

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
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(write, debounceMs);
  };
  const offSessions = sessions.subscribe(schedule);
  // A page that moves on changes no layout, but its URL is part of the snapshot.
  const offBrowser = subscribeBrowserTabs(schedule);
  const off = () => {
    offSessions();
    offBrowser();
  };
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

/** The part of a Tauri window that `watchWindowClose` uses. */
export interface CloseWindow {
  onCloseRequested(handler: (event?: { preventDefault(): void }) => void | Promise<void>): Promise<() => void>;
}

/**
 * Flushes the pending save when the window is asked to close (`beforeunload` is not reliable in a
 * Tauri window). `guard` runs first; when it says no, the close is prevented and nothing is saved.
 * It is the one close listener: Tauri closes the window after each listener that did not prevent it.
 * With no window (tests, a browser) it does nothing. Returns a function that stops listening.
 */
export function watchWindowClose(saver: Pick<LayoutSaver, "flush">, win: CloseWindow | null, guard?: () => Promise<boolean>): () => void {
  if (!win) return () => {};
  let off: (() => void) | null = null;
  let stopped = false;
  win
    .onCloseRequested(async (event) => {
      if (guard && !(await guard().catch(() => true))) {
        event?.preventDefault();
        return;
      }
      await saver.flush();
    })
    .then((un) => {
      if (stopped) un();
      else off = un;
    })
    .catch(() => {});
  return () => {
    stopped = true;
    off?.();
    off = null;
  };
}

/** The current Tauri window, or null outside Tauri. */
export async function currentCloseWindow(): Promise<CloseWindow | null> {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return null;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    return getCurrentWindow();
  } catch {
    return null;
  }
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
  api: Pick<Api, "layoutLoad" | "uiSettingsGet" | "agentSessions"> & Partial<Pick<Api, "startupMark">>,
  sessions: Sessions,
  known: (worktree: string) => boolean,
  openFile: (worktree: string, rel: string) => Promise<boolean>,
  carry?: (worktree: string) => boolean,
  note?: RestoreOptions["note"],
): Promise<LayoutRestore | null> {
  try {
    const began = Date.now();
    const [snapshot, ui] = await Promise.all([api.layoutLoad(), api.uiSettingsGet()]);
    // The panel width is the window's, not the tabs': it comes back under every restore mode.
    if (snapshot && snapshot.version === LAYOUT_VERSION && typeof snapshot.panelWidth === "number" && sessions.panelWidth() === null) sessions.setPanelWidth(snapshot.panelWidth);
    if (!snapshot || snapshot.version !== LAYOUT_VERSION || ui.restore === "none") {
      void markStartup(api, { id: "layout.restore", ok: true, ms: Date.now() - began });
      return null;
    }
    const report = await sessions.restore(snapshot, ui.restore, sessionFallback(api), { known, openFile, carry, note });
    void markStartup(api, { id: "layout.restore", ok: true, ms: Date.now() - began });
    return { mode: ui.restore, report };
  } catch (e) {
    const detail = e instanceof Error ? e.message : typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : String(e);
    void markStartup(api, { id: "layout.restore", ok: false, ms: 0, detail: detail.slice(0, 240) });
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
