import type { FileCommand, QuickCommand } from "@/api";
import { AGENT_START_MS, pastePrompt, ready } from "@/workspace/agentPrompt";
import type { Sessions, Tab } from "@/workspace/sessions";

export interface RunContext {
  sessions: Sessions;
  worktree: string;
  /** The tab a terminal command is typed into: the one in front, or null. */
  tab: Tab | null;
  /** Overrides "Press Enter after" for this run only (Shift+Enter in the popover). */
  appendEnter?: boolean;
  /** Set for a command from `xdev.toml`: whether that file's commands are trusted. Absent counts as not. */
  trusted?: boolean;
  /** The agent profile ids that can start; when given, an agent prompt for another id is refused. */
  profiles?: readonly string[];
  /** How long a new agent tab gets to become ready. */
  timeoutMs?: number;
  /** Gives the keyboard back to the terminal that was typed into. */
  focus?: (tab: Tab) => void;
  /** Told the id of a saved command that ran, for the recent list. */
  used?: (id: string) => void;
}

export type RunResult =
  | { ok: true; tab: Tab }
  | { ok: false; reason: "noTerminal" | "agentNotReady" | "untrusted" | "unknownAgent" };

const isSaved = (cmd: QuickCommand | FileCommand): cmd is QuickCommand => "id" in cmd;

/** The bytes that type a terminal command: lines joined by Enter, and one more at the end when asked. */
export function terminalBytes(command: string, appendEnter: boolean): string {
  return command.replace(/\r\n|\n/g, "\r") + (appendEnter ? "\r" : "");
}

/**
 * Runs one command: a terminal command is typed into `ctx.tab`, an agent prompt opens a new agent
 * tab and is pasted once that tab is ready. A command from `xdev.toml` runs only when `ctx.trusted`.
 */
export async function runQuickCommand(cmd: QuickCommand | FileCommand, ctx: RunContext): Promise<RunResult> {
  if (!isSaved(cmd) && ctx.trusted !== true) return { ok: false, reason: "untrusted" };
  const action = cmd.action;
  let tab: Tab;
  if (action.type === "terminal") {
    if (!ctx.tab || ctx.tab.exitCode !== undefined) return { ok: false, reason: "noTerminal" };
    tab = ctx.tab;
    await tab.client.input(terminalBytes(action.command, ctx.appendEnter ?? action.appendEnter));
    ctx.focus?.(tab);
  } else {
    if (ctx.profiles && !ctx.profiles.includes(action.profile)) return { ok: false, reason: "unknownAgent" };
    const opened = ctx.sessions.open(ctx.worktree, action.profile);
    const started = await ready(ctx.sessions, ctx.worktree, opened.id, ctx.timeoutMs ?? AGENT_START_MS);
    if (!started) return { ok: false, reason: "agentNotReady" };
    tab = started;
    await tab.client.input(pastePrompt(action.prompt));
  }
  if (isSaved(cmd)) ctx.used?.(cmd.id);
  return { ok: true, tab };
}
