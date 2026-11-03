import type { Sessions, Tab } from "./sessions";
import { sendTarget } from "./sendTarget";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
// ESC, DEL and every C0 control except tab (\x09) and newline (\x0a). A carriage return is
// dropped too, after CRLF became LF, so a stray one never submits half a prompt.
const CONTROLS = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** The bytes that type `text` into an agent as one pasted block and press Enter. */
export function pastePrompt(text: string): string {
  return PASTE_START + text.replace(/\r\n/g, "\n").replace(CONTROLS, "") + PASTE_END + "\r";
}

const running = (tab: Tab) => tab.agent && tab.status !== "failed" && tab.status !== "exited";

/** How long a new agent tab gets to start and go quiet before the prompt is given up. */
export const AGENT_START_MS = 30_000;

/**
 * Types `text` into an agent tab of `worktree`: the one in front when it is a running agent tab,
 * else the first running agent tab, else a new `claude` tab, once it has started (it was working
 * and went idle) so the prompt is not typed into a launching shell. Resolves the tab used, or
 * `null` when a new tab did not get ready in time.
 */
export async function sendToAgentTab(
  sessions: Sessions,
  worktree: string,
  shown: string | null,
  text: string,
  wait: { timeoutMs: number } = { timeoutMs: AGENT_START_MS },
): Promise<Tab | null> {
  const tabs = sessions.tabs(worktree);
  let tab = sendTarget(tabs, shown) ?? tabs.find(running) ?? null;
  if (!tab) {
    const opened = sessions.open(worktree, "claude");
    tab = await ready(sessions, worktree, opened.id, wait.timeoutMs);
    if (!tab) return null;
  }
  await tab.client.input(pastePrompt(text));
  return tab;
}

// Resolves the tab at its first idle after it worked, or null at the timeout or when it ends.
function ready(sessions: Sessions, worktree: string, id: string, timeoutMs: number): Promise<Tab | null> {
  return new Promise((resolve) => {
    let worked = false;
    let off = () => {};
    const done = (tab: Tab | null) => {
      clearTimeout(timer);
      off();
      resolve(tab);
    };
    const timer = setTimeout(() => done(null), timeoutMs);
    off = sessions.subscribe(() => {
      const tab = sessions.tabs(worktree).find((t) => t.id === id);
      if (!tab || !running(tab)) return done(null);
      if (tab.status === "working") worked = true;
      else if (tab.status === "idle" && worked) done(tab);
    });
  });
}
