import type { Home, Skill, UsageSummary } from "@/api";

export type Tokens = UsageSummary["days"][number][1];

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** A one-line cut: the text up to `max` characters, with an ellipsis when it was longer. */
export function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/** What a home is called on screen: its agent, with the account or a note about where it came from. */
export function homeLabel(homes: Home[], id: string | null, t: Translate): string {
  if (id === null) return t("kit.home.none");
  const home = homes.find((h) => h.id === id);
  if (!home) return id;
  if (home.source === "own") return home.agent;
  if (home.source === "env") return t("kit.home.env", { agent: home.agent });
  return t("kit.home.account", { agent: home.agent, account: home.source.account });
}

/** The name of the agent that loads a skill; an id this version does not know is shown as it is. */
export function agentLabel(agent: string, t: Translate): string {
  const known = ["claude", "codex", "agents", "gemini", "cursor", "factory"];
  return known.includes(agent) ? t(`kit.agent.${agent}`) : agent;
}

/** The separator a path uses, so a joined path looks like its neighbours. */
export function sepOf(path: string): string {
  return path.includes("\\") && !path.includes("/") ? "\\" : "/";
}

export function joinPath(base: string, ...parts: string[]): string {
  const sep = sepOf(base);
  return [base.replace(/[\\/]+$/, ""), ...parts.map((p) => p.replace(/^[\\/]+|[\\/]+$/g, ""))].join(sep);
}

/** A path as people read it: without the `\\?\` prefix Windows canonical paths carry. */
export function displayPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) return `\\\\${path.slice(8)}`;
  return path.startsWith("\\\\?\\") ? path.slice(4) : path;
}

/** `path` below `root` without the leading separator, or `null` when it is not below it. */
export function below(root: string, path: string): string | null {
  const clean = (p: string) => displayPath(p).replace(/\\/g, "/").replace(/\/+$/, "");
  const r = clean(root);
  const p = clean(path);
  if (p === r) return "";
  return p.startsWith(`${r}/`) ? p.slice(r.length + 1) : null;
}

/** A folder shown relative to the first registered repo that holds it; the path itself otherwise. */
export function relativeFolder(folder: string, roots: string[]): string {
  for (const root of roots) {
    const rel = below(root, folder);
    if (rel === null) continue;
    const name = root.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? root;
    return rel === "" ? name : `${name}/${rel}`;
  }
  return displayPath(folder);
}

/** A count in the reader's locale, with its digit grouping (`12,345`). */
export function formatCount(n: number, locale?: string): string {
  return new Intl.NumberFormat(locale).format(n);
}

export function totalOf(t: Tokens): number {
  return t.input + t.output + t.cache_read + t.cache_write;
}

/** Local `YYYY-MM-DD`, the day format the usage index uses. */
export function localDay(date: Date): string {
  const two = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}

/** The last `count` local days ending today: `[since, until]`, both included. */
export function dayRange(count: number, now: Date): [string, string] {
  const since = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (count - 1));
  return [localDay(since), localDay(now)];
}

/** Where a skill can be put: each home's `skills` folder, and the worktree's own when there is one. */
export interface SkillTarget {
  dir: string;
  label: string;
}

export function skillTargets(homes: Home[], worktree: string | null, t: Translate): SkillTarget[] {
  const targets = homes.map((h) => ({ dir: joinPath(h.path, "skills"), label: homeLabel(homes, h.id, t) }));
  if (worktree !== null) targets.push({ dir: joinPath(worktree, ".claude", "skills"), label: t("kit.scope.project") });
  return targets;
}

export function scopeKey(skill: Skill): "user" | "project" | "plugin" {
  return typeof skill.scope === "string" ? skill.scope : "plugin";
}

export function scopeLabel(skill: Skill, t: Translate): string {
  if (typeof skill.scope === "string") return t(`kit.scope.${skill.scope}`);
  return t("kit.scope.plugin", { name: skill.scope.plugin.plugin });
}
