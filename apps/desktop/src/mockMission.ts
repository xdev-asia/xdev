import type { Api, ApiError, LinkGrant, MissionSettings, MissionTab, OrchMessage, OrchWorker, TabLink, TabWorker } from "./api";

type MissionApi = Pick<
  Api,
  | "orchestrationMission"
  | "orchestrationMissionSettingsPut"
  | "orchestrationLinkPut"
  | "orchestrationLinkGrant"
  | "orchestrationLinkRetarget"
  | "orchestrationLinkRemove"
  | "orchestrationNudge"
  | "orchestrationHandoff"
  | "orchestrationTabStop"
>;

export type MockMission = MissionApi & {
  // Every nudge and hand-off typed, oldest first.
  __nudges(): { tab: string; text: string; at: number }[];
  __handoffs(): { from: string; to: string; text: string }[];
  // Replaces the demo tabs.
  __missionTabs(tabs: MissionTab[]): void;
};

const MIN = 60_000;
export const NUDGE_TEXT = "Are you stuck? Say in one line what you are waiting for, then carry on.";

function reject(detail: string): Promise<never> {
  const error: ApiError = { code: "orchestration", detail };
  return Promise.reject(error);
}

function worker(tab: string, task: string, title: string): TabWorker {
  return { tab, dispatchId: `disp_${tab}`, runId: "run_demo", state: "ready", taskId: task, taskTitle: title, updatedMs: 0 };
}

/** The demo team: a lead, a builder silent for 25 minutes, a reviewer waiting on the person, a docs writer at work. */
export function demoMissionTabs(now: number): MissionTab[] {
  const tab = (id: string, title: string, status: string, ago: number, w: TabWorker | null): MissionTab => ({
    id,
    title,
    worktree: "/demo/xdev",
    profile: "claude",
    agent: true,
    status,
    lastOutputMs: now - ago,
    exited: false,
    worker: w,
    lastNudgeMs: null,
  });
  return [
    tab("demo-lead", "Lead", "idle", 1 * MIN, null),
    tab("demo-builder", "Builder", "working", 25 * MIN, worker("demo-builder", "task_retry", "Add retry to fetchJson")),
    tab("demo-review", "Reviewer", "needs-you", 3 * MIN, worker("demo-review", "task_review", "Review the retry change")),
    tab("demo-docs", "Docs writer", "working", 20_000, worker("demo-docs", "task_docs", "Document the retry option")),
  ];
}

/** Mission Control's side of the demo: tabs, links and settings in memory. */
export function createMockMission(clock: () => number = Date.now): MockMission {
  let tabs = demoMissionTabs(clock());
  let links: TabLink[] = [{ from: "demo-lead", to: "demo-builder", transcript: true, screen: false, createdMs: clock(), updatedMs: clock() }];
  let settings: MissionSettings = { stuckMinutes: 10, nudgePrompt: NUDGE_TEXT };
  const nudges: { tab: string; text: string; at: number }[] = [];
  const handoffs: { from: string; to: string; text: string }[] = [];
  let seq = 0;
  const find = (from: string, to: string) => links.find((l) => l.from === from && l.to === to);
  const live = (id: string) => tabs.find((t) => t.id === id && !t.exited);
  const message = (from: string, to: string, subject: string, body: string, type: OrchMessage["type"]): OrchMessage => {
    seq += 1;
    const at = clock();
    return { id: `msg_${seq}`, runId: "", from, to: `tab:${to}`, subject, body, type, priority: "normal", threadId: null, payload: null, read: true, seq, createdMs: at, deliveredMs: at };
  };
  return {
    async orchestrationMission() {
      const open = new Set(tabs.map((t) => t.id));
      links = links.filter((l) => open.has(l.from) && open.has(l.to));
      return { tabs: structuredClone(tabs), links: structuredClone(links), settings: { ...settings }, nowMs: clock() };
    },
    async orchestrationMissionSettingsPut(s) {
      const text = s.nudgePrompt.trim();
      settings = { stuckMinutes: Math.min(1440, Math.max(1, Math.round(s.stuckMinutes) || 1)), nudgePrompt: text === "" ? NUDGE_TEXT : text.slice(0, 500) };
      return { ...settings };
    },
    async orchestrationLinkPut(from, to) {
      if (from === to) return reject("bad_request: a tab cannot be linked to itself");
      const had = find(from, to);
      if (had) return { ...had };
      const l: TabLink = { from, to, transcript: false, screen: false, createdMs: clock(), updatedMs: clock() };
      links = [...links, l];
      return { ...l };
    },
    async orchestrationLinkGrant(from, to, grant: LinkGrant, on) {
      const l = find(from, to);
      if (!l) return reject(`not_found: no link ${from} -> ${to}`);
      if (grant === "transcript") l.transcript = on;
      else l.screen = on;
      l.updatedMs = clock();
      return { ...l };
    },
    async orchestrationLinkRetarget(from, to, target) {
      const l = find(from, to);
      if (!l) return reject(`not_found: no link ${from} -> ${to}`);
      if (from === target) return reject("bad_request: a tab cannot be linked to itself");
      if (to !== target && find(from, target)) return reject(`conflict: ${from} is already linked to ${target}`);
      if (to !== target) Object.assign(l, { to: target, transcript: false, screen: false, updatedMs: clock() });
      return { ...l };
    },
    async orchestrationLinkRemove(from, to) {
      const before = links.length;
      links = links.filter((l) => !(l.from === from && l.to === to));
      return links.length < before;
    },
    async orchestrationNudge(tab) {
      const t = live(tab);
      if (!t) return reject(`not_found: no open tab ${tab}`);
      if (!t.agent) return reject(`terminal_not_agent: tab ${tab} runs no agent`);
      const at = clock();
      t.lastNudgeMs = at;
      nudges.push({ tab, text: settings.nudgePrompt, at });
      return message("app:mission", tab, "nudge", settings.nudgePrompt, "status");
    },
    async orchestrationHandoff(from, to, text) {
      if (text.trim() === "") return reject("bad_request: nothing to hand off");
      if (from === to) return reject("bad_request: a tab cannot hand off to itself");
      const t = live(to);
      if (!t) return reject(`not_found: no open tab ${to}`);
      if (!t.agent) return reject(`terminal_not_agent: tab ${to} runs no agent`);
      handoffs.push({ from, to, text: text.trim() });
      return message(`tab:${from}`, to, "handoff", text.trim(), "handoff");
    },
    async orchestrationTabStop(tab) {
      const t = live(tab);
      if (!t?.worker) return reject(`not_worker: ${tab} runs no worker`);
      const w: OrchWorker = { dispatchId: t.worker.dispatchId, tab, worktree: t.worktree, agent: t.profile, state: "stopping", failedStage: null, lastError: null, kept: false, closesAtMs: null, released: false, createdMs: 0, updatedMs: clock() };
      tabs = tabs.filter((x) => x.id !== tab);
      return w;
    },
    __nudges: () => nudges.map((n) => ({ ...n })),
    __handoffs: () => handoffs.map((h) => ({ ...h })),
    __missionTabs(next) {
      tabs = structuredClone(next);
    },
  };
}
