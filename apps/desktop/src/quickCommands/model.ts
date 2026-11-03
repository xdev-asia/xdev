import type { FileCommand, FileCommands, QuickAction, QuickCommand } from "@/api";
import type { Selected } from "./store";

export type Badge = "enter" | "insert" | "agent";
/** Why a row cannot run now. */
export type Reason = "noTerminal" | "untrusted" | "unknownAgent";
export type Source = "recent" | "project" | "file" | "global";

export interface Row {
  /** Unique in a list: a command can show under Recent and under its own scope. */
  key: string;
  source: Source;
  cmd: QuickCommand | FileCommand;
  label: string;
  badge: Badge;
  /** The command, or the prompt; one line. */
  detail: string;
  /** Null when it can run. */
  reason: Reason | null;
}

export interface Section {
  id: Source;
  rows: Row[];
  /** The `xdev.toml` commands are listed but cannot run until trusted. */
  untrusted?: boolean;
}

/** What decides whether a row can run. */
export interface Env {
  /** The tab in front is a live terminal. */
  hasTerminal: boolean;
  /** The agent profile ids that can start; null while unknown (nothing is refused then). */
  profiles: readonly string[] | null;
}

export const badgeOf = (action: QuickAction): Badge => (action.type === "agent" ? "agent" : action.appendEnter ? "enter" : "insert");

/** The text of a command on one line: its first line, with an ellipsis when there is more. */
export function oneLine(text: string): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  const first = (lines[0] ?? "").trim();
  return lines.length > 1 ? `${first} …` : first;
}

export const textOf = (action: QuickAction): string => (action.type === "agent" ? action.prompt : action.command);

/** Why a command cannot run now, or null. `trusted` only matters for a file command. */
export function reasonOf(action: QuickAction, env: Env, trusted: boolean): Reason | null {
  if (!trusted) return "untrusted";
  if (action.type === "terminal") return env.hasTerminal ? null : "noTerminal";
  return env.profiles !== null && !env.profiles.includes(action.profile) ? "unknownAgent" : null;
}

function row(source: Source, key: string, cmd: QuickCommand | FileCommand, env: Env, trusted: boolean): Row {
  return {
    key: `${source}:${key}`,
    source,
    cmd,
    label: cmd.label,
    badge: badgeOf(cmd.action),
    detail: oneLine(textOf(cmd.action)),
    reason: reasonOf(cmd.action, env, trusted),
  };
}

const matches = (cmd: QuickCommand | FileCommand, query: string): boolean =>
  cmd.label.toLowerCase().includes(query) || textOf(cmd.action).toLowerCase().includes(query);

/**
 * The popover's sections, in order: Recent (only without a search), Project, From xdev.toml, Global.
 * Empty sections are left out. A search keeps the commands whose label or text contains it.
 */
export function buildSections(sel: Selected, file: FileCommands | null, query: string, env: Env): Section[] {
  const q = query.trim().toLowerCase();
  const keep = <T extends QuickCommand | FileCommand>(cmds: readonly T[]) => (q === "" ? [...cmds] : cmds.filter((c) => matches(c, q)));
  const out: Section[] = [];
  if (q === "") out.push({ id: "recent", rows: sel.recent.map((c) => row("recent", c.id, c, env, true)) });
  out.push({ id: "project", rows: keep(sel.project).map((c) => row("project", c.id, c, env, true)) });
  const fileCmds = file ? keep(file.commands) : [];
  out.push({
    id: "file",
    untrusted: file ? !file.trusted : false,
    rows: fileCmds.map((c) => row("file", String(file!.commands.indexOf(c)), c, env, file!.trusted)),
  });
  out.push({ id: "global", rows: keep(sel.global).map((c) => row("global", c.id, c, env, true)) });
  return out.filter((s) => s.rows.length > 0);
}

export const flatRows = (sections: readonly Section[]): Row[] => sections.flatMap((s) => s.rows);

/** The next row that can run, from `from` (an index into `rows`, -1 for none) in direction `dir`; wraps. */
export function stepRow(rows: readonly Row[], from: number, dir: 1 | -1): number {
  for (let n = 1; n <= rows.length; n++) {
    const i = (((from + dir * n) % rows.length) + rows.length) % rows.length;
    if (rows[i].reason === null) return i;
  }
  return from;
}

export type PopoverEffect = { kind: "run"; row: Row; appendEnter?: false } | { kind: "close" };

/** One key in the popover list: the active row after it and what to do. Pure, so no DOM is needed to test it. */
export function popoverKey(rows: readonly Row[], active: number, key: string, shift: boolean): { active: number; effect?: PopoverEffect } {
  switch (key) {
    case "ArrowDown":
      return { active: stepRow(rows, active, 1) };
    case "ArrowUp":
      return { active: stepRow(rows, active, -1) };
    case "Escape":
      return { active, effect: { kind: "close" } };
    case "Enter": {
      const r = rows[active];
      if (!r || r.reason !== null) return { active };
      // Shift+Enter types a terminal command without Enter, for this run only.
      const bare = shift && r.cmd.action.type === "terminal";
      return { active, effect: bare ? { kind: "run", row: r, appendEnter: false } : { kind: "run", row: r } };
    }
    default:
      return { active };
  }
}
