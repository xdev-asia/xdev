import type { SkillStatus } from "@/api";

/** The five how-to cards: the id keys the i18n text (`settings.orchestration.howTo.<id>.*`). */
export const HOW_TO = [
  { id: "handoff", icon: "swap" },
  { id: "worktree-handoff", icon: "swap" },
  { id: "child-sequence", icon: "list-checks" },
  { id: "child-parallel", icon: "branch" },
  { id: "child-worktrees", icon: "workflow" },
] as const;
export type HowToId = (typeof HOW_TO)[number]["id"];

export const DEPTH_MIN = 1;
export const DEPTH_MAX = 9;

/** The number the nested-depth field commits: digits only, clamped to 1..=9; anything else keeps `previous`. */
export function parseDepth(raw: string, previous: number): number {
  const text = raw.trim();
  if (!/^\d+$/.test(text)) return previous;
  return Math.min(DEPTH_MAX, Math.max(DEPTH_MIN, Number(text)));
}

export type CoverageLine = { key: string; vars?: Record<string, number>; hint: boolean };

/** The sentence under "Agent coverage": null status is still loading. */
export function coverageLine(status: SkillStatus | null): CoverageLine {
  if (status === null) return { key: "settings.orchestration.coverage.checking", hint: false };
  const detected = status.agents.filter((a) => a.detected);
  if (detected.length === 0) return { key: "settings.orchestration.coverage.none", hint: false };
  const ready = detected.filter((a) => a.ready).length;
  if (ready === detected.length) return { key: "settings.orchestration.coverage.all", vars: { count: ready }, hint: false };
  return { key: "settings.orchestration.coverage.some", vars: { ready, total: detected.length }, hint: true };
}

export type SkillState = "installed" | "edited" | "notInstalled";
export const skillState = (s: SkillStatus | null): SkillState => (s === null || !s.installed ? "notInstalled" : s.edited ? "edited" : "installed");

/** A prompt for the clipboard: the text as shown, without surrounding blank space. */
export const promptText = (text: string): string => text.trim();
