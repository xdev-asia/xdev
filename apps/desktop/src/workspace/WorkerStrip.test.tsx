import type { ReactElement } from "react";
import { expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { translate } from "@/i18n";
import { mount, nodes, type Node } from "@/kit/testHooks";
import { WorkerStrip } from "./WorkerStrip";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

// The stand-in draws elements, and a hidden strip draws null.
const Strip = WorkerStrip as unknown as (p: Parameters<typeof WorkerStrip>[0]) => ReactElement;
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const banner = (all: Node[]) => all.find((n) => n.props.action !== undefined && n.props.title !== undefined);

it("renders nothing for a tab that is no worker", async () => {
  const api = createMockApi({});
  const m = mount(Strip, () => ({ api, tab: "t1" }));
  expect(banner(await m.settle())).toBeUndefined();
});

it("shows the rule for a running worker and the countdown for a finished one", async () => {
  const api = createMockApi({});
  api.__orchSetLifetime("t1", { kept: false, closesAtMs: null, finished: false });
  const m = mount(Strip, () => ({ api, tab: "t1", now: () => 0, running: true }));
  expect(banner(await m.settle())!.props.title).toBe(en("orchestration.worker.running"));
  api.__orchSetLifetime("t1", { kept: false, closesAtMs: 102_000, finished: true });
  api.__orchWorkerChanged({ tab: "t1" });
  await new Promise((r) => setTimeout(r, 0));
  expect(banner(m.all())!.props.title).toBe(en("orchestration.worker.finished", { countdown: "1:42" }));
});

it("Keep open hides the strip at once and a change event for another tab does nothing", async () => {
  const api = createMockApi({});
  api.__orchSetLifetime("t1", { kept: false, closesAtMs: 50_000, finished: true });
  const m = mount(Strip, () => ({ api, tab: "t1", now: () => 0 }));
  const all = await m.settle();
  const keep = nodes(banner(all)!.props.action)[0]!;
  expect(keep.props.children).toBe(en("orchestration.worker.keepOpen"));
  expect(keep.props.variant).toBe("secondary");
  keep.props.onClick();
  expect(banner(m.all())).toBeUndefined();
  await new Promise((r) => setTimeout(r, 0));
  api.__orchWorkerChanged({ tab: "other" });
  expect(banner(m.all())).toBeUndefined();
});

it("is hidden when auto-close is off", async () => {
  const api = createMockApi({});
  await api.orchestrationSettingsPut({ nestedWorkerMaxDepth: 1, workerAutoClose: false });
  api.__orchSetLifetime("t1", { kept: false, closesAtMs: null, finished: false });
  const m = mount(Strip, () => ({ api, tab: "t1", now: () => 0, running: true }));
  expect(banner(await m.settle())).toBeUndefined();
});

it("is hidden for a worker with no running agent that has not finished", async () => {
  const api = createMockApi({});
  api.__orchSetLifetime("t1", { kept: false, closesAtMs: null, finished: false });
  const m = mount(Strip, () => ({ api, tab: "t1", now: () => 0, running: false }));
  expect(banner(await m.settle())).toBeUndefined();
});
