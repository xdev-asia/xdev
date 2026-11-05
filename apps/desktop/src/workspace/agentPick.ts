/** The order `auto` tries the built-in agents in; mirrors `AUTO_ORDER` in `crates/xdev-agent`. */
export const AUTO_ORDER = [
  "claude", "codex", "copilot", "opencode", "gemini", "aider", "goose", "amp", "cursor", "droid", "kimi", "qwen-code", "devin",
] as const;

/**
 * The profile id the default agent starts: the saved agent when it is usable, else the first usable
 * agent of the auto order; `null` (a shell) for `blank` or when nothing is usable.
 */
export function pickAgent(defaultAgent: string, usable: (id: string) => boolean): string | null {
  if (defaultAgent === "blank") return null;
  if (defaultAgent !== "auto" && usable(defaultAgent)) return defaultAgent;
  return AUTO_ORDER.find((id) => usable(id)) ?? null;
}
