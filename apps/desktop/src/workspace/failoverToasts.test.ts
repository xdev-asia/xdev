import { afterEach, beforeEach, expect, it } from "vitest";
import { createMockApi } from "@/mockApi";
import { translate } from "@/i18n";
import type { WorkerFailover } from "@/api";
import { getToasts, pushToast, resetToastsForTests } from "./toastStore";
import { failoverToastId, watchFailovers } from "./failoverToasts";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); await new Promise((r) => setTimeout(r, 0)); };
const failed: WorkerFailover = { task: "task-1", fromDispatch: "d1", fromTab: "t1", fromAgent: "claude", reason: "rate_limited" };

let stop: (() => void) | null = null;
beforeEach(() => resetToastsForTests());
afterEach(() => {
  stop?.();
  stop = null;
  resetToastsForTests();
});

async function setup() {
  const api = createMockApi({});
  stop = watchFailovers({ api, t, toast: pushToast });
  await tick();
  return api;
}

it("one toast per failover, naming both agents and the reason", async () => {
  const api = await setup();
  api.__orchFailover({ ...failed, kind: "failover", dispatch: "d2", tab: "t2", agent: "codex" });
  await tick();
  api.__orchFailover({ ...failed, kind: "failover", dispatch: "d2", tab: "t2", agent: "codex" });
  await tick();
  expect(getToasts().map((x) => [x.id, x.text])).toEqual([
    [failoverToastId(failed), t("orchestration.failover.toast.failover", { from: "Claude Code", reason: t("orchestration.failover.reason.rate_limited"), to: "Codex" })],
  ]);
});

it("a restart and a worker marked failed have their own texts", async () => {
  const api = await setup();
  api.__orchFailover({ ...failed, fromDispatch: "d5", reason: "stuck", kind: "restart" });
  api.__orchFailover({ ...failed, fromDispatch: "d6", fromAgent: "custom-agent" });
  await tick();
  expect(getToasts().map((x) => x.text)).toEqual([
    t("orchestration.failover.toast.restart", { from: "Claude Code", reason: t("orchestration.failover.reason.stuck") }),
    t("orchestration.failover.toast.failed", { from: "custom-agent", reason: t("orchestration.failover.reason.rate_limited") }),
  ]);
});

it("stops listening when stopped", async () => {
  const api = await setup();
  stop!();
  stop = null;
  api.__orchFailover(failed);
  await tick();
  expect(getToasts()).toEqual([]);
});

it("the mock fails a worker over to the first backup agent only when failover is on", async () => {
  const api = createMockApi({});
  const opened: string[] = [];
  await api.onOrchestrationOpenWorker((e) => opened.push(`${e.tab}:${e.profile}:${e.setup}`));
  const from = { dispatch: "d1", tab: "w1", title: "Fix", worktree: "/demo", profile: "claude", prompt: "Do it", setup: "inherit", readyTimeoutMs: 60_000 };
  expect(await api.__orchFailWorker(from)).toBeNull();
  expect(opened).toEqual([]);
  await api.orchestrationSettingsPut({ ...(await api.orchestrationSettings()), failoverEnabled: true, failoverBackupAgents: ["codex"] });
  expect(await api.__orchFailWorker(from, "crashed")).toBe("w1-f1");
  expect(opened).toEqual(["w1-f1:codex:skip"]);
  expect(await api.orchestrationWorkerFailover("w1-f1")).toEqual({ fromAgent: "claude", reason: "crashed", kind: "failover" });
  expect(await api.orchestrationWorkerFailover("w1")).toBeNull();
});
