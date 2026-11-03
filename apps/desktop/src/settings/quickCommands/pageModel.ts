import type { FileCommands, QuickCommand } from "@/api";
import { textOf } from "@/quickCommands/model";

export interface RepoOption {
  /** The repo registry key (its path). */
  path: string;
  name: string;
}

/** "all", "global", or a repo path. */
export type Filter = string;

export type Group =
  | { kind: "global"; id: string; items: QuickCommand[] }
  | { kind: "repo"; id: string; repo: RepoOption; items: QuickCommand[] }
  /** Commands tied to a repo that is no longer in xDev: only Delete is offered (plan R3). */
  | { kind: "unknown"; id: string; items: QuickCommand[] }
  /** The read-only `[[commands]]` of a repo's `xdev.toml`. */
  | { kind: "file"; id: string; repo: RepoOption; file: FileCommands };

const sameScope = (a: QuickCommand, b: QuickCommand): boolean =>
  a.scope.type === b.scope.type && (a.scope.type === "global" || (b.scope.type === "repo" && a.scope.repo === b.scope.repo));

const matches = (c: { label: string; action: QuickCommand["action"] }, q: string): boolean =>
  c.label.toLowerCase().includes(q) || textOf(c.action).toLowerCase().includes(q);

/**
 * The page's groups: Global, then each repo with its own commands and its `xdev.toml` ones, then
 * commands of repos that are gone. A search keeps the commands whose label or text contains it; a
 * filter keeps one scope. Empty groups are left out.
 */
export function buildGroups(
  items: readonly QuickCommand[],
  repos: readonly RepoOption[],
  files: Record<string, FileCommands | undefined>,
  query: string,
  filter: Filter,
): Group[] {
  const q = query.trim().toLowerCase();
  const keep = (c: QuickCommand) => q === "" || matches(c, q);
  const out: Group[] = [];
  if (filter === "all" || filter === "global") {
    const rows = items.filter((c) => c.scope.type === "global" && keep(c));
    if (rows.length) out.push({ kind: "global", id: "global", items: rows });
  }
  for (const repo of repos) {
    if (filter !== "all" && filter !== repo.path) continue;
    const rows = items.filter((c) => c.scope.type === "repo" && c.scope.repo === repo.path && keep(c));
    if (rows.length) out.push({ kind: "repo", id: `repo:${repo.path}`, repo, items: rows });
    const file = files[repo.path];
    if (file && (file.commands.length > 0 || file.errors.length > 0)) {
      const shown = q === "" ? file : { ...file, commands: file.commands.filter((c) => matches(c, q)) };
      if (shown.commands.length > 0 || (q === "" && shown.errors.length > 0)) out.push({ kind: "file", id: `file:${repo.path}`, repo, file: shown });
    }
  }
  if (filter === "all") {
    const known = new Set(repos.map((r) => r.path));
    const gone = items.filter((c) => c.scope.type === "repo" && !known.has(c.scope.repo) && keep(c));
    if (gone.length) out.push({ kind: "unknown", id: "unknown", items: gone });
  }
  return out;
}

/** The index `id` moves to inside its scope for one step up or down; null at the edge or when unknown. */
export function moveTarget(items: readonly QuickCommand[], id: string, dir: -1 | 1): number | null {
  const cmd = items.find((c) => c.id === id);
  if (!cmd) return null;
  const scoped = items.filter((c) => sameScope(c, cmd));
  const at = scoped.findIndex((c) => c.id === id);
  const to = at + dir;
  return to < 0 || to >= scoped.length ? null : to;
}
