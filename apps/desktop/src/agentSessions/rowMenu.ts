import type { MenuEntry } from "@xdev-asia/ui";
import type { SessionRow, SessionTurn } from "@/api";

/** What the CLIs accept as a session id; anything else would need shell quoting, so it gets no command. */
const SAFE_ID = /^[A-Za-z0-9_-]+$/;

/** The shell command that continues a session, as the Rust resume builds it; `null` when the agent or id has none. */
export function resumeCommand(row: SessionRow): string | null {
  const { agent, id } = row.session;
  if (!SAFE_ID.test(id)) return null;
  if (agent === "claude") return `claude --resume ${id}`;
  if (agent === "codex") return `codex resume ${id}`;
  return null;
}

/** How many of the last turns are read to find the latest prompt. */
export const RECENT_PROMPT_TURNS = 50;
/** The most characters of that prompt. */
export const RECENT_PROMPT_CHARS = 8_000;

/** The text of the last user turn of `turns` (oldest first); `null` when there is none or it is blank. */
export function lastUserPrompt(turns: SessionTurn[]): string | null {
  const turn = [...turns].reverse().find((t) => t.role === "user");
  const text = turn?.text.trim() ?? "";
  return text === "" ? null : text;
}

export interface RowMenuActions {
  handOff(): void;
  copyCommand(command: string): void;
  jump(): void;
  copyFirstPrompt?(text: string): void;
  /** Reads the session's latest prompt and copies it; the item shows only when given. */
  copyRecentPrompt?(): void;
  /** Each of these three shows its item only when given. */
  copyLogPath?(): void;
  revealLog?(): void;
  deleteSession?(): void;
}

/** The row's "More" menu: hand off, the resume command when the agent has one, the first prompt when there is one, and the open tab when there is one. */
export function rowMenuItems(
  row: SessionRow,
  tab: string | null,
  t: (key: string) => string,
  actions: RowMenuActions,
  canHandOff: boolean,
): MenuEntry[] {
  const command = resumeCommand(row);
  const prompt = row.session.title?.trim() ?? "";
  const items: MenuEntry[] = [];
  if (tab !== null) items.push({ label: t("agentSessions.menu.jump"), onSelect: actions.jump });
  items.push({ label: t("agentSessions.menu.handOff"), disabled: !canHandOff, onSelect: actions.handOff });
  if (command !== null) items.push({ label: t("agentSessions.menu.copyCommand"), onSelect: () => actions.copyCommand(command) });
  if (prompt !== "" && actions.copyFirstPrompt) items.push({ label: t("agentSessions.menu.copyFirstPrompt"), onSelect: () => actions.copyFirstPrompt?.(prompt) });
  if (actions.copyRecentPrompt) items.push({ label: t("agentSessions.menu.copyRecentPrompt"), onSelect: actions.copyRecentPrompt });
  if (actions.copyLogPath) items.push({ label: t("agentSessions.menu.copyLogPath"), onSelect: actions.copyLogPath });
  if (actions.revealLog) items.push({ label: t("agentSessions.menu.revealLog"), onSelect: actions.revealLog });
  if (actions.deleteSession) items.push({ type: "separator" }, { label: t("agentSessions.menu.delete"), danger: true, onSelect: actions.deleteSession });
  return items;
}
