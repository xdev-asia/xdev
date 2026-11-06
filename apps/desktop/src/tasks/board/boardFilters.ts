import type { BoardTask, TaskPriority, TaskStatus } from "@/api";

/** What the filter bar holds. Values inside one field are alternatives; the fields are all required. */
export interface BoardFilters {
  search: string;
  status: TaskStatus[];
  priority: TaskPriority[];
  agent: string[];
  label: string[];
}

export const NO_FILTERS: BoardFilters = { search: "", status: [], priority: [], agent: [], label: [] };

/** Whether any field narrows the list. */
export function isFiltering(f: BoardFilters): boolean {
  return f.search.trim() !== "" || f.status.length > 0 || f.priority.length > 0 || f.agent.length > 0 || f.label.length > 0;
}

/** The tasks that pass every field; the search matches the title and the labels, ignoring case. */
export function applyFilters(tasks: readonly BoardTask[], f: BoardFilters): BoardTask[] {
  const q = f.search.trim().toLowerCase();
  return tasks.filter((t) => {
    if (q && !t.title.toLowerCase().includes(q) && !t.labels.some((l) => l.toLowerCase().includes(q))) return false;
    if (f.status.length > 0 && !f.status.includes(t.status)) return false;
    if (f.priority.length > 0 && !f.priority.includes(t.priority)) return false;
    if (f.agent.length > 0 && !(t.assignee !== null && f.agent.includes(t.assignee))) return false;
    if (f.label.length > 0 && !t.labels.some((l) => f.label.includes(l))) return false;
    return true;
  });
}

const LISTS = ["status", "priority", "agent", "label"] as const;

/** The filters as a query string; empty fields are left out. */
export function toQuery(f: BoardFilters): string {
  const p = new URLSearchParams();
  if (f.search.trim()) p.set("q", f.search.trim());
  for (const key of LISTS) if (f[key].length > 0) p.set(key, f[key].join(","));
  return p.toString();
}

const STATUSES: readonly string[] = ["backlog", "todo", "in-progress", "in-review", "done"];
const PRIORITIES: readonly string[] = ["p0", "p1", "p2", "p3"];

/** Reads `toQuery` back; anything unknown or malformed is dropped, so a stale value never breaks the board. */
export function fromQuery(s: string | null | undefined): BoardFilters {
  const p = new URLSearchParams(s ?? "");
  const list = (key: string, allowed?: readonly string[]): string[] =>
    (p.get(key) ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter((v) => v !== "" && (!allowed || allowed.includes(v)));
  return {
    search: p.get("q") ?? "",
    status: list("status", STATUSES) as TaskStatus[],
    priority: list("priority", PRIORITIES) as TaskPriority[],
    agent: list("agent"),
    label: list("label"),
  };
}

/** The `sessionStorage` key of a repo's filters. */
export const filtersKey = (repo: string): string => `xdev.board.filters.${repo}`;

export function loadFilters(repo: string): BoardFilters {
  try {
    return fromQuery(sessionStorage.getItem(filtersKey(repo)));
  } catch {
    return NO_FILTERS;
  }
}

export function saveFilters(repo: string, f: BoardFilters): void {
  try {
    const q = toQuery(f);
    if (q) sessionStorage.setItem(filtersKey(repo), q);
    else sessionStorage.removeItem(filtersKey(repo));
  } catch {
    // Private mode: the filters just do not survive a reload.
  }
}

/** The distinct values of a task field, sorted, for the chips. */
export function distinct(tasks: readonly BoardTask[], pick: (t: BoardTask) => string | readonly string[] | null): string[] {
  const out = new Set<string>();
  for (const t of tasks) {
    const v = pick(t);
    if (v === null) continue;
    for (const x of typeof v === "string" ? [v] : v) out.add(x);
  }
  return [...out].sort((a, b) => a.localeCompare(b));
}
