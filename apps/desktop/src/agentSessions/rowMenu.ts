import type { MenuEntry } from "@xdev-asia/ui";
import type { SessionRow } from "@/api";

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

export interface RowMenuActions {
  handOff(): void;
  copyCommand(command: string): void;
  jump(): void;
  copyFirstPrompt?(text: string): void;
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
  return items;
}
