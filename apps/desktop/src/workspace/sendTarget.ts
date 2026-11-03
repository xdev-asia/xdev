import type { Tab } from "./sessions";

/** The tab a prompt is typed into: the one in front, when it is an agent tab that is still running. */
export function sendTarget(tabs: readonly Tab[], shown: string | null): Tab | null {
  const tab = tabs.find((t) => t.id === shown);
  return tab && tab.agent && tab.status !== "failed" && tab.status !== "exited" ? tab : null;
}
