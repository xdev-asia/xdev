import type { PrSummary, ReviewBranch, WorkItem, WorktreeView } from "@/api";
import { numberedName } from "@/issues/issueStart";

/** The most cone folders a worktree may be limited to, as in `names::SPARSE_MAX`. */
export const SPARSE_MAX = 50;

/**
 * The folders typed one per line, normalized as the desktop does (`\` as `/`, no leading `./` or
 * trailing `/`, duplicates dropped), or "bad" for an absolute path, a `.` or `..` part, a leading `-`,
 * a control char or more than `SPARSE_MAX` folders. Blank lines are skipped.
 */
export function sparseDirs(text: string): string[] | "bad" {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let d = raw.trim().replace(/\\/g, "/");
    while (d.startsWith("./")) d = d.slice(2);
    d = d.replace(/\/+$/, "");
    if (d === "") continue;
    // eslint-disable-next-line no-control-regex
    const bad = d.startsWith("-") || d.startsWith("/") || d[1] === ":" || /[\u0000-\u001f\u007f]/.test(d) || d.split("/").some((p) => p === "" || p === "." || p === "..");
    if (bad) return "bad";
    if (!out.includes(d)) out.push(d);
  }
  return out.length <= SPARSE_MAX ? out : "bad";
}

/** The local branches a worktree can still be put on: no remote ones, none checked out in a worktree. */
export function localBranches(branches: ReviewBranch[], worktrees: WorktreeView[]): string[] {
  const taken = new Set(worktrees.map((w) => w.branch).filter((b): b is string => b !== null));
  return branches.filter((b) => !b.remote && !taken.has(b.name)).map((b) => b.name);
}

export function prWorkItem(pr: PrSummary): WorkItem {
  return { kind: "pr", url: pr.url, title: pr.title };
}

/** `pr-12-fix-footer-meter`: the folder a pull request's worktree gets; `pr-12` when the title leaves nothing. */
export function prWorktreeName(pr: PrSummary): string {
  return numberedName(pr.number, pr.title, "pr").replace(/^(\d+)/, "pr-$1");
}

export interface BaseRefOption {
  name: string;
  isDefault: boolean;
}

/**
 * The refs a new branch can start from: the project default first (its name is "" when none is set),
 * then every branch once, sorted, narrowed by the query and cut at `limit` rows. `typed` is the trimmed
 * query when it is not empty and equals no name, so a tag or SHA can still be used.
 */
export function baseRefOptions(branches: ReviewBranch[], baseRef: string | null, query: string, limit = 30): { options: BaseRefOption[]; typed: string | null } {
  const q = query.trim();
  const needle = q.toLowerCase();
  const def = baseRef ?? "";
  const rest = [...new Set(branches.map((b) => b.name))].filter((n) => n !== def).sort((a, b) => a.localeCompare(b));
  const all: BaseRefOption[] = [{ name: def, isDefault: true }, ...rest.map((name) => ({ name, isDefault: false }))];
  const options = all.filter((o) => needle === "" || o.name.toLowerCase().includes(needle)).slice(0, limit);
  const typed = q !== "" && !all.some((o) => o.name === q) ? q : null;
  return { options, typed };
}
