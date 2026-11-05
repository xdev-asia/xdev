import type { CommitRef, LogCommit, RepoLog } from "@/api";

// What the two boundary rows show as their id.
export const SYNTHETIC_ID = "0000000";
export const OPEN_CAP = 512;
export const MAX_TAGS = 2;
export const HISTORY_HEIGHT = { initial: 256, min: 96, max: 520, share: 0.33, step: 16 } as const;

export type Boundary = "incoming" | "outgoing";
export type RefMark = "head" | "remote" | "base";

// One line of the graph: a commit, or a boundary standing for the changes past it.
export type HistoryRow = {
  // Unique in the list; the graph's id for the row.
  key: string;
  // What the row shows and copies: the commit id, or `0000000` for a boundary.
  id: string;
  subject: string;
  parents: string[];
  marks: RefMark[];
  boundary: Boundary | null;
  commit: LogCommit | null;
  tags: CommitRef[];
  // The tags that did not fit, as `+n` with these names in the title.
  overflow: string[];
};

// The local branch name a remote ref copies, `origin/oak` → `oak`.
function remoteBranch(name: string): string {
  const slash = name.indexOf("/");
  return slash < 0 ? name : name.slice(slash + 1);
}

/**
 * The refs a row shows. A remote copy of a local branch on the same commit is noise and goes; the
 * base is always kept. At most two show, the rest are counted.
 */
export function displayRefs(refs: CommitRef[], base: string | null): { tags: CommitRef[]; overflow: string[] } {
  const local = new Set(refs.filter((r) => r.kind === "branch").map((r) => r.name));
  const kept = refs.filter((r) => r.name === base || !(r.kind === "remote" && local.has(remoteBranch(r.name))));
  return { tags: kept.slice(0, MAX_TAGS), overflow: kept.slice(MAX_TAGS).map((r) => r.name) };
}

/**
 * The rows of a log, in order. Incoming changes go before the merge base when the upstream has
 * moved, outgoing changes before `HEAD` when `HEAD` is past the merge base.
 */
export function historyRows(log: RepoLog): HistoryRow[] {
  const rows: HistoryRow[] = [];
  const marksOf = (id: string): RefMark[] => {
    const marks: RefMark[] = [];
    if (id === log.head) marks.push("head");
    if (log.upstream && id === log.upstream.id) marks.push("remote");
    if (log.base && id === log.base.id) marks.push("base");
    return marks;
  };
  const boundary = (kind: Boundary, parent: string, mark: RefMark): HistoryRow => ({
    key: kind,
    id: SYNTHETIC_ID,
    subject: "",
    parents: [parent],
    marks: [mark],
    boundary: kind,
    commit: null,
    tags: [],
    overflow: [],
  });
  for (const commit of log.commits) {
    if (log.outgoing && commit.id === log.head && log.head !== null) rows.push(boundary("outgoing", commit.id, "head"));
    if (log.incoming && commit.id === log.mergeBase && log.mergeBase !== null) rows.push(boundary("incoming", commit.id, "remote"));
    const { tags, overflow } = displayRefs(commit.refs, log.base?.name ?? null);
    rows.push({ key: commit.id, id: commit.id, subject: commit.subject, parents: commit.parents, marks: marksOf(commit.id), boundary: null, commit, tags, overflow });
  }
  return rows;
}

// A copy of `open` with this worktree set. Past the cap the oldest entry goes, and setting an entry
// again makes it the newest.
export function rememberOpen(open: ReadonlyMap<string, boolean>, worktree: string, value: boolean): Map<string, boolean> {
  const next = new Map(open);
  next.delete(worktree);
  next.set(worktree, value);
  while (next.size > OPEN_CAP) {
    const oldest = next.keys().next();
    if (oldest.done) break;
    next.delete(oldest.value);
  }
  return next;
}

// The panel's height: within 96–520 px and at most a third of the window, never under the minimum.
export function clampHistoryHeight(height: number, windowHeight: number): number {
  const { min, max, share } = HISTORY_HEIGHT;
  const top = Math.max(min, Math.min(max, Math.floor(windowHeight * share)));
  return Math.min(top, Math.max(min, Math.round(height)));
}
