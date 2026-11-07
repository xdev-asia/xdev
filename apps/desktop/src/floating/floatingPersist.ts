import type { Api, PtydStatus, RestoreMode } from "@/api";
import { toApiError } from "@/api";
import { restoreBrowserTab, subscribeBrowserTabs } from "@/browser/browserTabs";
import { PtyClient } from "@/terminal/ptyClient";
import type { LayoutSaver } from "@/workspace/layoutPersist";
import { clearLegacyNote, loadLegacyNote } from "./floatingNote";
import { NOTE_MAX_BYTES, cutUtf8, parseFloatingSnapshot } from "./floatingSnapshot";
import {
  FLOATING_WORKTREE,
  applyRestored,
  registerFloatingClient,
  snapshotFloating,
  subscribeFloating,
  type FloatingTab,
} from "./floatingStore";

/** How long after the last change the floating workspace is written. */
export const FLOATING_SAVE_DEBOUNCE_MS = 1000;

export interface FloatingSaver {
  /** Writes now, if a change is waiting (or `force`). */
  flush(force?: boolean): Promise<void>;
  stop(): void;
}

// The saver now running, so the close guard can flush it without being handed it.
let current: FloatingSaver | null = null;
// A legacy note was moved into a tab; its key goes after the first save that succeeds.
let legacyPending = false;
let loggedTooLarge = false;

const newTermId = (): string => `floating-term-${crypto.randomUUID()}`;

/**
 * Brings the saved floating workspace back: terminals attach to the ptys the terminal service kept
 * (else start fresh), browsers and notes are recreated. Never throws; the panel stays closed.
 */
export async function loadFloating(api: Api): Promise<void> {
  let raw: unknown = null;
  try {
    raw = await api.floatingLoad();
  } catch {
    raw = null;
  }
  const snap = parseFloatingSnapshot(raw);
  const rows = snap?.tabs ?? [];

  let mode: RestoreMode = "all";
  try {
    mode = (await api.uiSettingsGet()).restore;
  } catch {
    // The default keeps tabs.
  }
  let ptyd: PtydStatus["state"] = "off";
  if (rows.some((r) => r.kind === "terminal")) {
    try {
      ptyd = (await api.ptydStatus()).state;
    } catch {
      ptyd = "off";
    }
  }

  const tabs: FloatingTab[] = [];
  const ids = new Map<number, string>();
  for (const [i, row] of rows.entries()) {
    if (row.kind === "terminal") {
      if (mode === "none") {
        // Nothing else lists floating ptys; left alone they would run unseen.
        api.ptydEnd(row.id).catch(() => {});
        continue;
      }
      const id = (await attachOrFresh(api, row, ptyd === "running" || ptyd === "old-version")) ?? newTermId();
      const tab: FloatingTab = { id, kind: "terminal", n: row.n };
      if (row.cwd) tab.cwd = row.cwd;
      tabs.push(tab);
      ids.set(i, id);
    } else if (row.kind === "browser") {
      const id = restoreBrowserTab(FLOATING_WORKTREE, row.url, row.title ?? null);
      tabs.push({ id, kind: "browser", n: tabs.length + 1 });
      ids.set(i, id);
    } else {
      const id = `floating-note-${crypto.randomUUID()}`;
      tabs.push({ id, kind: "note", n: row.n, body: row.body });
      ids.set(i, id);
    }
  }

  if (!rows.some((r) => r.kind === "note")) {
    const legacy = loadLegacyNote();
    if (legacy !== "") {
      tabs.push({ id: `floating-note-${crypto.randomUUID()}`, kind: "note", n: 1, body: cutUtf8(legacy, NOTE_MAX_BYTES) });
      legacyPending = true;
    }
  }

  const active = snap?.active != null ? ids.get(snap.active) : undefined;
  applyRestored(tabs, active ?? tabs[0]?.id ?? null);
}

/** The id of the terminal after an attach; null when it comes back fresh (a new id, the saved cwd). */
async function attachOrFresh(api: Api, row: { id: string; seq?: number }, serviceUp: boolean): Promise<string | null> {
  if (!serviceUp) return null;
  const from = row.seq ?? 0;
  const client = new PtyClient(api, row.id);
  try {
    await client.attach(from);
  } catch (e) {
    // Only a pty the service does not hold comes back fresh; any other failure keeps the tab, which
    // attaches again when it starts and shows that error if it fails again.
    if (toApiError(e).code === "pty_gone") return null;
    client.attachOnStart(from);
  }
  registerFloatingClient(row.id, client);
  return row.id;
}

/**
 * Saves `snapshotFloating()` one second after the last change (the store, or a browser page's URL
 * or title), and at once on `flush`. Start it after `loadFloating`, or a snapshot of nothing would
 * replace the file waiting to be read.
 */
export function startFloatingSave(api: Pick<Api, "floatingSave">, debounceMs = FLOATING_SAVE_DEBOUNCE_MS): FloatingSaver {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const write = (): Promise<void> => {
    timer = null;
    return api
      .floatingSave(snapshotFloating())
      .then(() => {
        if (legacyPending) {
          legacyPending = false;
          clearLegacyNote();
        }
      })
      .catch((e: unknown) => {
        // The last good file stays. A full disk is not worth a dialog; too_large is logged once.
        if (toApiError(e).code === "too_large" && !loggedTooLarge) {
          loggedTooLarge = true;
          console.error("floating workspace is too large to save");
        }
      });
  };
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => void write(), debounceMs);
  };
  const offStore = subscribeFloating(schedule);
  const offBrowser = subscribeBrowserTabs(schedule);
  // A moved legacy note is saved soon, so its key does not wait for the first edit.
  if (legacyPending) schedule();
  const saver: FloatingSaver = {
    async flush(force = false) {
      if (timer === null && !force) return;
      if (timer !== null) clearTimeout(timer);
      await write();
    },
    stop() {
      offStore();
      offBrowser();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      if (current === saver) current = null;
    },
  };
  current = saver;
  return saver;
}

/** The layout saver and the floating one as one flush, for the window close guard. */
export function withFloatingSave(layout: Pick<LayoutSaver, "flush"> | null): Pick<LayoutSaver, "flush"> {
  return {
    async flush() {
      await Promise.all([layout?.flush(), current?.flush()]);
    },
  };
}

/** For tests. */
export function resetFloatingPersistForTests(): void {
  current = null;
  legacyPending = false;
  loggedTooLarge = false;
}
