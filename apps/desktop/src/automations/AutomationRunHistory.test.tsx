import { expect, it, vi } from "vitest";
import type { AutomationRun } from "@/api";
import { mount, nodes, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { AutomationRunHistory } from "./AutomationRunHistory";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const NOW = 1_793_793_600_000;

function run(n: number, over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: `r${n}`, automationId: "a1", title: `Audit run ${n}`, runNumber: n, scheduledFor: NOW, status: "completed", trigger: "scheduled", worktree: null, worktreeName: null, tabId: null,
    outputSnapshot: null, precheckResult: null, error: null, errorCode: null, errorParams: null, startedAt: null, dispatchedAt: null, finishedAt: null, createdAt: NOW,
    occurrenceCount: 1, lastOccurrenceAt: null, ...over,
  };
}

const view = (runs: AutomationRun[], onOpen = vi.fn(), exists = () => true) => mount(AutomationRunHistory, () => ({ runs, exists, onOpen })).all();
const rows = (all: Node[]) => all.filter((n) => n.props["data-act"] === "run");
const dots = (all: Node[]) => all.filter((n) => n.props.state !== undefined && n.props.label !== undefined);

it("says there are no runs yet", () => {
  const all = view([]);
  expect(all.map((n) => (typeof n.props.children === "string" ? n.props.children : "")).join("")).toContain("No runs yet.");
  expect(rows(all)).toEqual([]);
});

it("has the Run, Status and Workspace columns", () => {
  const heads = view([run(1)]).filter((n) => n.type === "th").map(textOf);
  expect(heads).toEqual(["Run", "Status", "Workspace"]);
});

it("lists each run with its status and workspace", () => {
  const all = view(
    [run(2, { status: "dispatch_failed", worktree: "/w/auto-x", worktreeName: "auto-x" }), run(1, { status: "skipped_missed" })],
    vi.fn(),
    () => false,
  );
  expect(rows(all)).toHaveLength(2);
  expect(dots(all).map((d) => d.props.label)).toEqual(["Failed", "Skipped"]);
  const cells = all.filter((n) => n.type === "td").map(textOf);
  expect(cells).toContain("auto-x (no longer available)");
  expect(cells).toContain("Not launched");
});

it("says how often a skipped run repeated", () => {
  const all = view([run(1, { status: "skipped_unavailable", occurrenceCount: 4, lastOccurrenceAt: NOW })]);
  const text = all.map((n) => (typeof n.props.children === "string" ? n.props.children : "")).join("|");
  expect(text).toMatch(/4 times, most recently/);
  expect(view([run(1)]).map((n) => (typeof n.props.children === "string" ? n.props.children : "")).join("|")).not.toMatch(/times, most recently/);
});

it("sums the runs and the completed ones, in the singular for one", () => {
  const text = (runs: AutomationRun[]) => view(runs).map((n) => (typeof n.props.children === "string" ? n.props.children : "")).join("|");
  expect(text([run(1), run(2, { status: "dispatch_failed" }), run(3)])).toContain("3 runs · 2 completed");
  expect(text([run(1)])).toContain("1 run · 1 completed");
});

it("opens a run from its title", () => {
  const onOpen = vi.fn();
  const all = view([run(1)], onOpen);
  all.find((n) => n.props["data-act"] === "open-run")!.props.onClick();
  expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "r1" }));
  void nodes;
});
