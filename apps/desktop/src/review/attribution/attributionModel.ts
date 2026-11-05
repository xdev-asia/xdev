import type { AgentProfile } from "@xdev-asia/ui";
import type { FileAttribution, Toucher } from "@/api";

/** Who touched each file, by path. */
export function touchersByPath(files: readonly FileAttribution[]): Map<string, Toucher[]> {
  return new Map(files.map((f) => [f.path, f.touchedBy]));
}

/** Two or more different tabs wrote the file. An unknown writer is not a tab, so it never makes a file "multi". */
export function isMulti(touchers: readonly Toucher[] | undefined): boolean {
  return new Set((touchers ?? []).flatMap((t) => (t.tabId ? [t.tabId] : []))).size >= 2;
}

/** How many different tabs wrote the file. */
export function agentCount(touchers: readonly Toucher[] | undefined): number {
  return new Set((touchers ?? []).flatMap((t) => (t.tabId ? [t.tabId] : []))).size;
}

/** The files of `paths` that several tabs touched. */
export function multiPaths(paths: readonly string[], byPath: ReadonlyMap<string, readonly Toucher[]>): string[] {
  return paths.filter((p) => isMulti(byPath.get(p)));
}

/** `claude` and `codex` have their own chip; any other agent is custom. */
export function profileOf(agent: string | null): AgentProfile {
  return agent === "claude" || agent === "codex" ? agent : "custom";
}

/** The letter of a custom agent's chip: its first letter, uppercase; "?" for unknown. `claude` and `codex` keep the chip's own letters. */
export function letterOf(agent: string | null): string | undefined {
  if (profileOf(agent) !== "custom") return undefined;
  return agent ? agent.charAt(0).toUpperCase() : "?";
}

/**
 * The text beside a chip. The agent's name; when two chips of one file share a name, each gets the
 * last four characters of its tab id so they can be told apart. `unknown` is the word for no agent.
 */
export function chipNames(touchers: readonly Toucher[], unknown: string): string[] {
  const names = touchers.map((t) => t.agent ?? unknown);
  return touchers.map((t, i) => {
    const same = names.filter((n) => n === names[i]).length > 1;
    return same && t.tabId ? `${names[i]} ${t.tabId.slice(-4)}` : names[i];
  });
}
