import { expect, it, vi } from "vitest";
import { createMockApi, type RunUsage } from "@/api";
import { mount, nodes, tick, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { RunsDashboard } from "./RunsDashboard";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const NOW = 1_793_793_600_000;
const HOUR = 3_600_000;
const usage: RunUsage = { tokensIn: 1000, tokensOut: 500, tokensCache: 0, cost: { nanos: 2_500_000_000, priced: true, unpriced: false } };

function input(name: string) {
  return {
    name, prompt: "Look", precheck: null, agent: "claude", extraAgentArgs: null, repoId: "r1", workspaceMode: "existing" as const, worktree: "/w", baseBranch: null,
    setupDecision: "inherit" as const, reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0", dtstart: NOW, enabled: true, missedRunGraceMinutes: 720,
  };
}

async function open(seed: (api: ReturnType<typeof createMockApi>) => Promise<void> = async () => {}, onOpen = vi.fn()) {
  const api = createMockApi({});
  await seed(api);
  const m = mount(RunsDashboard, () => ({ api, reloadKey: 0, onOpen }));
  for (let i = 0; i < 3; i++) await m.settle();
  return { api, m, onOpen };
}

const act = (all: Node[], name: string) => all.filter((n) => n.props["data-act"] === name);
const cells = (all: Node[]) => all.filter((n) => n.type === "td").map(textOf);

it("says so when the range has no runs", async () => {
  const { m } = await open();
  const all = m.all();
  expect(all.find((n) => n.props.title === "No runs in this range")).toBeDefined();
  expect(act(all, "run")).toEqual([]);
});

it("lists the runs with usage where known and - where not", async () => {
  const { m } = await open(async (api) => {
    const a = await api.automationCreate(input("Audit"));
    const known = api.__automationAddRun({ automationId: a.id, status: "completed", startedAt: Date.now() - HOUR, finishedAt: Date.now() - HOUR + 125_000 });
    api.__automationAddRun({ automationId: a.id, status: "dispatch_failed", startedAt: Date.now() - 2 * HOUR, finishedAt: Date.now() - 2 * HOUR + 1000 });
    api.__automationUsage(known.id, usage);
  });
  const all = m.all();
  const rows = act(all, "run");
  expect(rows).toHaveLength(2);
  const first = nodes(rows[0]).filter((n) => n.type === "td").map(textOf);
  const second = nodes(rows[1]).filter((n) => n.type === "td").map(textOf);
  expect(first[0]).toBe("Audit");
  expect(first[2]).toBe("2m 05s");
  expect(first[4]).toBe("1.5K");
  expect(first[5]).toBe("$2.50");
  expect(second.slice(4)).toEqual(["-", "-"]);
  expect(cells(all).length).toBe(12);
});

it("shows the summary: runs, success rate, tokens and cost", async () => {
  const { m } = await open(async (api) => {
    const a = await api.automationCreate(input("Audit"));
    const ok = api.__automationAddRun({ automationId: a.id, status: "completed", startedAt: Date.now() - HOUR, finishedAt: Date.now() - HOUR + 1000 });
    api.__automationAddRun({ automationId: a.id, status: "dispatch_failed", startedAt: Date.now() - 2 * HOUR, finishedAt: Date.now() - 2 * HOUR + 1000 });
    api.__automationUsage(ok.id, usage);
  });
  const tiles = m.all().filter((n) => n.props.label !== undefined && n.props.value !== undefined && n.props.options === undefined);
  expect(tiles.map((n) => [n.props.label, n.props.value])).toEqual([["Runs", "2"], ["Success rate", "50%"], ["Tokens", "1.5K"], ["Cost", "$2.50"]]);
  expect(tiles[2].props.hint).toBe("1 of 2 runs have usage");
});

it("opens the clicked run and sorts by cost on the header", async () => {
  const onOpen = vi.fn();
  const { m } = await open(async (api) => {
    const a = await api.automationCreate(input("Audit"));
    const cheap = api.__automationAddRun({ automationId: a.id, status: "completed", startedAt: Date.now() - HOUR });
    const dear = api.__automationAddRun({ automationId: a.id, status: "completed", startedAt: Date.now() - 2 * HOUR });
    api.__automationUsage(cheap.id, { ...usage, cost: { nanos: 1_000_000, priced: true, unpriced: false } });
    api.__automationUsage(dear.id, usage);
  }, onOpen);
  const order = () => act(m.all(), "run").map((r) => r.props["data-run"]);
  const [newest, oldest] = order();
  act(m.all(), "sort-cost")[0].props.onClick();
  expect(order()).toEqual([oldest, newest]);
  act(m.all(), "run")[0].props.onClick();
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ runId: oldest }));
});

it("loads the range the picker names", async () => {
  const api = createMockApi({});
  const spy = vi.spyOn(api, "automationRunsSummary");
  const m = mount(RunsDashboard, () => ({ api, reloadKey: 0, onOpen: vi.fn() }));
  await m.settle();
  await tick();
  expect(spy).toHaveBeenCalledWith("7d");
  const picker = m.all().find((n) => Array.isArray(n.props.options));
  expect(picker?.props.options.map((o: { value: string }) => o.value)).toEqual(["24h", "7d", "30d"]);
  picker!.props.onChange("30d");
  await m.settle();
  expect(spy).toHaveBeenLastCalledWith("30d");
});
