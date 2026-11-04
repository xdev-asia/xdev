import type { Api, OnQuit, PtydState } from "@/api";
import type { Tab } from "./sessions";

/** What the quit question names: the live tabs, and the ones working right now. */
export interface QuitAsk {
  count: number;
  working: { id: string; title: string }[];
}

export type QuitChoice = "keep" | "end" | "cancel";

/**
 * The question to ask before the window closes, or null to close at once. Only "On quit: Ask" asks,
 * only while the terminal service runs (in the app, terminals end with it anyway), and only with a
 * tab still alive.
 */
export function quitAsk(onQuit: OnQuit, state: PtydState | null, tabs: readonly Tab[]): QuitAsk | null {
  if (onQuit !== "ask" || (state !== "running" && state !== "old-version")) return null;
  const live = tabs.filter((t) => t.exitCode === undefined);
  if (live.length === 0) return null;
  const working = live.filter((t) => t.status === "working").map((t) => ({ id: t.id, title: t.title ?? t.profileId }));
  return { count: live.length, working };
}

/**
 * Before the window closes: asks when `quitAsk` says so and gives the answer to the backend, which
 * reads it on exit. False when the person cancelled, and the window stays.
 */
export async function askQuit(
  api: Pick<Api, "ptydStatus" | "ptydQuitChoice">,
  onQuit: () => OnQuit,
  tabs: () => readonly Tab[],
  show: (ask: QuitAsk) => Promise<QuitChoice>,
): Promise<boolean> {
  if (onQuit() !== "ask") return true;
  const state = (await api.ptydStatus().catch(() => null))?.state ?? null;
  const ask = quitAsk(onQuit(), state, tabs());
  if (!ask) return true;
  const choice = await show(ask);
  if (choice === "cancel") return false;
  await api.ptydQuitChoice(choice === "end").catch(() => {});
  return true;
}

/**
 * The whole close guard: the shell decides first. `hide` means it already hid the window to the
 * tray, so the close stops here (false). Otherwise `ask` runs the quit question; on a cancel the
 * shell is told, so a quit it started does not stay in flight.
 */
export async function guardClose(
  api: Pick<Api, "shellCloseRequested" | "shellQuitCancelled">,
  notice: { title: string; body: string },
  ask: () => Promise<boolean>,
): Promise<boolean> {
  const intent = await api.shellCloseRequested(notice.title, notice.body).catch(() => "close" as const);
  if (intent === "hide") return false;
  const go = await ask();
  if (!go) await api.shellQuitCancelled().catch(() => {});
  return go;
}
