import type { Tab } from "./sessions";

/** An agent tab whose pty has not exited. A failed turn (`failed` without an exit) still takes a prompt. */
export const runningAgent = (tab: Tab): boolean => tab.agent && tab.exitCode === undefined;

/** The tab a prompt is typed into: the one in front, when it is an agent tab that is still running. */
export function sendTarget(tabs: readonly Tab[], shown: string | null): Tab | null {
  const tab = tabs.find((t) => t.id === shown);
  return tab && runningAgent(tab) ? tab : null;
}
