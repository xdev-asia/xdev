import { expect, it, vi } from "vitest";
import { Breadcrumb, Button, StatusDot } from "@xdev-asia/ui";
import type { AutomationRun } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { AutomationRunDetails } from "./AutomationRunDetails";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const NOW = 1_793_793_600_000;
const wt = DEMO_WORKSPACE.repos[0].worktrees[0].path;

function run(over: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: "r1", automationId: "a1", title: "Audit run 4", runNumber: 4, scheduledFor: NOW - 5 * 60_000, status: "completed", trigger: "scheduled", worktree: null, worktreeName: null,
    tabId: null, outputSnapshot: null, precheckResult: null, error: null, errorCode: null, errorParams: null, startedAt: null, dispatchedAt: null, finishedAt: null, createdAt: NOW - 5 * 60_000,
    occurrenceCount: 1, lastOccurrenceAt: null, ...over,
  };
}

function view(r: AutomationRun, over: Partial<Parameters<typeof AutomationRunDetails>[0]> = {}) {
  const props = { run: r, automation: {} as never, exists: () => true, now: NOW, onBack: vi.fn(), onRerun: vi.fn(), onOpenWorkspace: vi.fn(), ...over };
  return { all: mount(AutomationRunDetails, () => props).all(), props };
}

const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);

it("goes back to the runs", () => {
  const { all, props } = view(run());
  expect(textOf(act(all, "back")!)).toBe("Back to runs");
  act(all, "back")!.props.onClick();
  expect(props.onBack).toHaveBeenCalled();
});

it("titles the run and walks the breadcrumb: when, the product, the workspace", () => {
  const { all } = view(run({ worktree: wt, worktreeName: "auto-audit" }));
  expect(textOf(all.find((n) => n.type === "h2")!)).toBe("Audit run 4");
  const items = all.find((n) => n.type === Breadcrumb)!.props.items as { label: string }[];
  expect(items[0].label).toMatch(/^Scheduled .*2026.* \(5 min\)$/);
  expect(items[1].label).toBe("xDev");
  expect(items[2].label).toBe("auto-audit");
  expect((view(run()).all.find((n) => n.type === Breadcrumb)!.props.items as { label: string }[])[2].label).toBe("No workspace");
});

it("shows the status badge", () => {
  const dot = view(run({ status: "dispatch_failed" })).all.find((n) => n.type === StatusDot)!;
  expect(dot.props).toMatchObject({ state: "failed", label: "Failed" });
});

it("Rerun is secondary and asks for a manual run; there is no primary button", () => {
  const { all, props } = view(run());
  const rerun = act(all, "rerun")!;
  expect(rerun.type).toBe(Button);
  expect(rerun.props.variant).toBe("secondary");
  rerun.props.onClick();
  expect(props.onRerun).toHaveBeenCalled();
  expect(all.filter((n) => n.props.variant === "primary")).toHaveLength(0);
  expect(view(run(), { automation: null }).all.find((n) => n.props["data-act"] === "rerun")!.props.disabled).toBe(true);
});

it("offers Open workspace only while the worktree still exists", () => {
  const here = view(run({ worktree: wt }));
  expect(textOf(act(here.all, "open-workspace")!)).toBe("Open workspace");
  act(here.all, "open-workspace")!.props.onClick();
  expect(here.props.onOpenWorkspace).toHaveBeenCalledWith(wt);
  expect(act(view(run({ worktree: wt }), { exists: () => false }).all, "open-workspace")).toBeUndefined();
  expect(act(view(run()).all, "open-workspace")).toBeUndefined();
});

it("puts an error notice on a failed run", () => {
  const failed = view(run({ status: "dispatch_failed", errorCode: "agentNeverStarted", error: "stored" })).all;
  expect([act(failed, "error")!.props.children].flat().map((c) => (typeof c === "string" ? c : textOf(c))).join("")).toBe("Error: The agent did not start working in time.");
  expect(act(view(run({ status: "skipped_precheck", error: "Precheck exited with code 1." })).all, "error")).toBeUndefined();
  expect(act(view(run()).all, "error")).toBeUndefined();
});

it("shows the output, else the precheck output, else the error, else a note", () => {
  const body = (r: AutomationRun) => textOf(view(r).all.find((n) => n.type === "pre")!);
  const pre = { command: "c", exitCode: 1, timedOut: false, durationMs: 1, stdout: "out", stderr: "err", stdoutTruncated: false, stderrTruncated: false, error: null, startedAt: 0, completedAt: 1 };
  const snap = { content: "agent said hi", capturedAt: 1, truncated: false };
  expect(body(run({ outputSnapshot: snap, precheckResult: pre, error: "e" }))).toBe("agent said hi");
  expect(body(run({ precheckResult: pre, error: "e" }))).toBe("err\nout");
  expect(body(run({ error: "boom" }))).toBe("boom");
  expect(body(run())).toBe("No output content available.");
});

it("says when only the last lines were kept", () => {
  const snap = { content: "tail", capturedAt: 1, truncated: true };
  const text = view(run({ outputSnapshot: snap })).all.map((n) => n.props.children).filter((c) => typeof c === "string");
  expect(text).toContain("Only the last lines of the output are kept.");
});
