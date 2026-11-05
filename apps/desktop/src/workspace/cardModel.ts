import type { CardProps, SidebarPrefs } from "@/api";

export type CardPart = keyof CardProps;

/** The ten properties a worktree card can show, in the order the options list them. */
export const CARD_PARTS: readonly CardPart[] = ["branch", "time", "comment", "workStatus", "workItem", "agents", "diffStat", "pr", "projectChip", "ports"];

/** A compact card is one line: only these parts can sit on it. */
const COMPACT_PARTS: readonly CardPart[] = ["time", "diffStat", "pr"];

/** The parts a card draws under the prefs. The status dot, the name, the pin and the unread mark always show. */
export function cardParts(prefs: SidebarPrefs): Set<CardPart> {
  const allowed = prefs.compactCards ? COMPACT_PARTS : CARD_PARTS;
  return new Set(allowed.filter((part) => prefs.card[part]));
}
