import type { ApiError, RemoteConnState, RemoteProjectView, RepoView, WorktreeView } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The `StatusDot` tone of a connection: connected = ok, connecting and reconnecting = busy (warn), offline = error. */
export type RemoteDot = { tone: "ok" | "warn" | "danger" | "neutral" };

export function stateDot(state: RemoteConnState): RemoteDot {
  switch (state.state) {
    case "connected":
      return { tone: "ok" };
    case "connecting":
    case "reconnecting":
      return { tone: "warn" };
    case "offline":
      return { tone: "danger" };
    case "idle":
      return { tone: "neutral" };
  }
}

/** The line that says what a state is, for a row's accessible name and the banner. */
export function stateText(t: T, state: RemoteConnState, host: string): string {
  switch (state.state) {
    case "reconnecting":
      return t("remote.state.reconnecting", { host, n: state.attempt });
    default:
      return t(`remote.state.${state.state}`, { host });
  }
}

/** True while the person cannot rely on the connection: anything but connected and idle. */
export function needsBanner(state: RemoteConnState): boolean {
  return state.state === "reconnecting" || state.state === "offline";
}

/** The last path segment, the default project name. */
export function lastSegment(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1) || trimmed || "/";
}

/** One row of the sidebar's Remote group. */
export interface RemoteRow {
  id: string;
  name: string;
  host: string;
  worktree: string;
  state: RemoteConnState;
  dot: RemoteDot;
}

/** The Remote group's rows, in the order the projects were added. */
export function remoteRows(projects: readonly RemoteProjectView[]): RemoteRow[] {
  return [...projects]
    .sort((a, b) => a.addedMs - b.addedMs)
    .map((p) => ({ id: p.id, name: p.name, host: p.hostAlias, worktree: p.worktree, state: p.state, dot: stateDot(p.state) }));
}

/** A project with the state of its host from a `remote://state` event; other hosts are untouched. */
export function applyState(projects: readonly RemoteProjectView[], hostId: string, state: RemoteConnState): RemoteProjectView[] {
  return projects.map((p) => (p.hostId === hostId ? { ...p, state } : p));
}

/**
 * The repo the shell lists for a remote project, so selection, tabs and the file tree work on its
 * `ssh://` worktree as on a local one. Its id starts with `remote:`; it never reaches the sidebar's
 * own list (the Remote group draws it).
 */
export function remoteRepo(p: RemoteProjectView): RepoView {
  const wt: WorktreeView = {
    path: p.worktree,
    name: p.name,
    branch: null,
    head: null,
    start: null,
    primary: true,
    pinned: false,
    detached: false,
    title: null,
    comment: "",
    status: null,
    parent: null,
    item: null,
    madeBy: "app",
    defaultBranch: false,
    autoName: false,
  };
  return {
    id: `remote:${p.id}`,
    shortName: p.name,
    path: p.worktree,
    baseRef: "",
    worktreeRoot: "",
    setupPolicy: "ask",
    scriptSource: "auto",
    localSetup: "",
    localArchive: "",
    color: null,
    icon: null,
    ghAccount: null,
    localIssueCommand: "",
    docsDir: "docs",
    missing: false,
    worktrees: [wt],
    found: [],
  };
}

/** The project owning an `ssh://` worktree, or undefined. */
export function projectOf(projects: readonly RemoteProjectView[], worktree: string | null): RemoteProjectView | undefined {
  return worktree === null ? undefined : projects.find((p) => p.worktree === worktree);
}

/** The text of a failed remote call: the `remote.error.*` line for a remote code, else the shared `error.*` one. */
export function remoteError(t: T, code: ApiError["code"], host: string): string {
  const key = `remote.error.${code}`;
  const own = t(key, { host });
  return own === key ? t(`error.${code}`) : own;
}
