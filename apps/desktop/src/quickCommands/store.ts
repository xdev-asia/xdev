import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { Api, FileCommands, QuickCommand } from "@/api";

/** Everything the quick commands UI reads; replaced as a whole on every change. */
export interface QuickCommandsState {
  /** Every saved command, global and per repo, in order. */
  items: QuickCommand[];
  /** Recently run ids, newest first. */
  recent: string[];
  /** `xdev.toml` commands per worktree path, once read. */
  files: Record<string, FileCommands | undefined>;
}

const EMPTY: QuickCommandsState = { items: [], recent: [], files: {} };
let state: QuickCommandsState = EMPTY;
const listeners = new Set<() => void>();
const inflight = new Map<string, Promise<void>>();

function set(next: Partial<QuickCommandsState>): void {
  state = { ...state, ...next };
  for (const l of [...listeners]) l();
}

export const getQuickCommands = (): QuickCommandsState => state;
export function subscribeQuickCommands(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

async function reload(api: Pick<Api, "quickCommandsList" | "quickCommandsRecent">): Promise<void> {
  try {
    const [items, recent] = await Promise.all([api.quickCommandsList(), api.quickCommandsRecent()]);
    set({ items, recent });
  } catch {
    // Keep the last list; the popover shows what it had.
  }
}

/**
 * Loads the list and keeps it current: it reloads whenever `settings://changed` names `quickCommands`.
 * Returns the stop function. Call it once for the window.
 */
export function startQuickCommands(api: Pick<Api, "quickCommandsList" | "quickCommandsRecent" | "onSettingsChanged">): () => void {
  void reload(api);
  return api.onSettingsChanged((e) => {
    if (e.sections.includes("quickCommands")) void reload(api);
  });
}

/** Reads the `[[commands]]` of a worktree's `xdev.toml` once; `force` reads again (the file may have changed). */
export function loadFileCommands(api: Pick<Api, "repoFileCommands">, worktree: string, force = false): Promise<void> {
  if (!force && state.files[worktree]) return Promise.resolve();
  const pending = inflight.get(worktree);
  if (pending && !force) return pending;
  const p = api
    .repoFileCommands(worktree)
    .then(
      (file) => set({ files: { ...state.files, [worktree]: file } }),
      () => {},
    )
    .finally(() => inflight.delete(worktree));
  inflight.set(worktree, p);
  return p;
}

/** Trusts the commands with this `hash`; true when they are trusted now. */
export async function trustFileCommands(api: Pick<Api, "repoFileCommandsTrust">, worktree: string, hash: string): Promise<boolean> {
  try {
    const file = await api.repoFileCommandsTrust(worktree, hash);
    set({ files: { ...state.files, [worktree]: file } });
    return file.trusted;
  } catch {
    return false;
  }
}

/** How many recent commands the popover lists. */
export const RECENT_SHOWN = 5;

export interface Selected {
  global: QuickCommand[];
  project: QuickCommand[];
  /** The commands run lately that are visible here, newest first. */
  recent: QuickCommand[];
}

/** What shows for a repo: every global command, the commands tied to `repo`, and the recent ones of both. */
export function selectCommands(s: QuickCommandsState, repo: string | null): Selected {
  const global = s.items.filter((c) => c.scope.type === "global");
  const project = repo === null ? [] : s.items.filter((c) => c.scope.type === "repo" && c.scope.repo === repo);
  const visible = new Map([...global, ...project].map((c) => [c.id, c]));
  const recent = s.recent.flatMap((id) => visible.get(id) ?? []).slice(0, RECENT_SHOWN);
  return { global, project, recent };
}

/**
 * The commands for a repo, and the `xdev.toml` ones of `worktree` (read when the worktree is on
 * screen). `file` is null until read.
 */
export function useQuickCommands(api: Pick<Api, "repoFileCommands">, repo: string | null, worktree: string | null): Selected & { file: FileCommands | null } {
  const s = useSyncExternalStore(subscribeQuickCommands, getQuickCommands, getQuickCommands);
  useEffect(() => {
    if (worktree) void loadFileCommands(api, worktree);
  }, [api, worktree]);
  const picked = useMemo(() => selectCommands(s, repo), [s, repo]);
  return { ...picked, file: (worktree && s.files[worktree]) || null };
}

/** Tests only. */
export function resetQuickCommands(): void {
  state = EMPTY;
  listeners.clear();
  inflight.clear();
}
