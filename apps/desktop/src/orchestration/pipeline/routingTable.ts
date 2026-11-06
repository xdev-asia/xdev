import type { MatchRow, RouteRule, RouteTarget, Routing } from "@/api";

/** A match-table row as the editor holds it: the keywords stay one text so a comma can be typed. */
export interface EditRow {
  keywords: string;
  label: string;
  agent: string;
  model: string;
  pool: string;
}

export const BLANK_EDIT: EditRow = { keywords: "", label: "", agent: "claude", model: "", pool: "" };
export const DEFAULT_EDIT: EditRow = { ...BLANK_EDIT };

export function parseKeywords(text: string): string[] {
  return text.split(",").map((k) => k.trim()).filter(Boolean);
}

export function toTarget(row: Pick<EditRow, "agent" | "model" | "pool">): RouteTarget {
  const target: RouteTarget = { agent: row.agent.trim() };
  if (row.model.trim()) target.model = row.model.trim();
  if (row.pool.trim()) target.pool = row.pool.trim();
  return target;
}

export function toRow(edit: EditRow): MatchRow {
  const row: MatchRow = { keywords: parseKeywords(edit.keywords), target: toTarget(edit) };
  if (edit.label.trim()) row.label = edit.label.trim();
  return row;
}

export function fromRow(row: MatchRow): EditRow {
  return { keywords: row.keywords.join(", "), label: row.label ?? "", agent: row.target.agent, model: row.target.model ?? "", pool: row.target.pool ?? "" };
}

export function fromTarget(target: RouteTarget | undefined): EditRow {
  return target ? { keywords: "", label: "", agent: target.agent, model: target.model ?? "", pool: target.pool ?? "" } : { ...DEFAULT_EDIT };
}

/** A row that can match something: it has a keyword or a label. */
export function hasCondition(edit: EditRow): boolean {
  return parseKeywords(edit.keywords).length > 0 || edit.label.trim() !== "";
}

/** The list with item `from` moved to `to` (both held inside the list); the same list when nothing moves. */
export function move<T>(list: readonly T[], from: number, to: number): T[] {
  const end = Math.min(Math.max(to, 0), list.length - 1);
  if (from < 0 || from >= list.length || from === end) return [...list];
  const next = [...list];
  const [item] = next.splice(from, 1);
  next.splice(end, 0, item);
  return next;
}

/** Where a row goes for a key: Alt+Up and Alt+Down move it one place; any other key moves nothing. */
export function keyTarget(key: string, alt: boolean, index: number, count: number): number | null {
  if (!alt) return null;
  if (key === "ArrowUp") return index > 0 ? index - 1 : null;
  if (key === "ArrowDown") return index < count - 1 ? index + 1 : null;
  return null;
}

/** What is saved: the match table and default row only when there are any, so a file made before stays as it was. */
export function savedRouting(rules: RouteRule[], table: EditRow[], fallback: EditRow | null, hadTable: boolean): Routing {
  const out: Routing = { rules: rules.map((r) => ({ ...r, model: r.model.trim() })) };
  if (table.length > 0 || hadTable) out.table = table.map(toRow);
  if (fallback) out.fallback = toTarget(fallback);
  return out;
}

/** `claude · opus · pool`: where a target goes. */
export function targetText(target: RouteTarget): string {
  return [target.agent, target.model, target.pool].filter(Boolean).join(" · ");
}

/** The table's problem, if any, as an i18n key: every row needs an agent and a keyword or a label. */
export function tableProblem(table: EditRow[], fallback: EditRow | null): "agent" | "condition" | null {
  if (table.some((r) => !r.agent.trim()) || (fallback && !fallback.agent.trim())) return "agent";
  if (table.some((r) => !hasCondition(r))) return "condition";
  return null;
}
