import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { StageStrip, type StageStripProps } from "./StageStrip";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Strip = StageStrip as unknown as (p: StageStripProps) => ReactElement;

function setup() {
  const api = createMockApi({});
  const m = mount(Strip, () => ({ api, subject: "squad:s1", worktree: "/w", defaultCheck: "cargo test", pollMs: 3_600_000 }));
  return { api, m };
}

const button = (all: Node[], text: string) => all.find((n) => n.type === "button" && n.props.children === text);
const stages = (all: Node[]) => all.filter((n) => n.type === "li" && n.props.className === "stage");
const status = (all: Node[]) => all.find((n) => n.props.role === "status")!;
const dialog = (all: Node[]) => all.find((n) => "confirmLabel" in n.props)!;
const flush = async (m: ReturnType<typeof mount>) => {
  await m.settle();
  return m.settle();
};

async function started(m: ReturnType<typeof mount>) {
  await m.settle();
  const form = m.all().find((n) => n.type === "form")!;
  form.props.onSubmit({ preventDefault() {} });
  return flush(m);
}

describe("StageStrip", () => {
  it("offers the three-stage pipeline first, with the squad's test command as the check", async () => {
    const { m } = setup();
    const all = await m.settle();
    expect(stages(all)).toHaveLength(0);
    const input = all.find((n) => n.type === "input")!;
    expect(input.props.value).toBe("cargo test");
    expect(button(all, en("pipeline.start"))).toBeDefined();
  });

  it("shows each stage's state and gate, announcing the start", async () => {
    const { m } = setup();
    const all = await started(m);
    const list = stages(all);
    expect(list.map((s) => s.props["data-status"])).toEqual(["running", "pending", "pending"]);
    expect(list[0].props["aria-current"]).toBe("step");
    expect(textOf(list[1])).toContain(en("pipeline.gate.check", { command: "cargo test" }));
    expect(textOf(list[2])).toContain(en("pipeline.gate.approval"));
    expect(textOf(status(all))).toBe(en("pipeline.announce.started", { name: en("pipeline.preset.name") }));
  });

  it("a stage that fails its gate stays put and shows why; retry confirms first, then passes", async () => {
    const { api, m } = setup();
    api.__pipelineExits([1]);
    await started(m);
    button(m.all(), en("pipeline.action.handOff"))!.props.onClick();
    await flush(m);
    button(m.all(), en("pipeline.action.handOff"))!.props.onClick();
    const failed = await flush(m);
    expect(stages(failed).map((s) => s.props["data-status"])).toEqual(["passed", "failed", "pending"]);
    expect(textOf(stages(failed)[1])).toContain("cargo exit 1: 1 test failed");
    expect(textOf(status(failed))).toContain(en("pipeline.announce.failed", { stage: en("pipeline.preset.tests"), reason: "cargo exit 1: 1 test failed" }));
    expect(button(failed, en("pipeline.action.handOff"))).toBeUndefined();

    const spy = vi.spyOn(api, "pipelineRetry");
    button(failed, en("pipeline.action.retry"))!.props.onClick();
    expect(spy).not.toHaveBeenCalled();
    const asking = m.all();
    expect(dialog(asking).props.open).toBe(true);
    expect(dialog(asking).props.title).toBe(en("pipeline.confirmRetry.title"));
    dialog(asking).props.onConfirm();
    const passed = await flush(m);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(stages(passed).map((s) => s.props["data-status"])).toEqual(["passed", "passed", "running"]);
    expect(textOf(status(passed))).toContain(en("pipeline.announce.passed", { stage: en("pipeline.preset.tests"), next: en("pipeline.preset.review") }));
  });

  it("cancelling the confirmation changes nothing", async () => {
    const { api, m } = setup();
    api.__pipelineExits([1]);
    await started(m);
    for (let i = 0; i < 2; i++) {
      button(m.all(), en("pipeline.action.handOff"))!.props.onClick();
      await flush(m);
    }
    const spy = vi.spyOn(api, "pipelineRetry");
    button(m.all(), en("pipeline.action.retry"))!.props.onClick();
    dialog(m.all()).props.onCancel();
    expect(dialog(m.all()).props.open).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it("an approval waits for the person: approve confirms first and finishes the pipeline", async () => {
    const { api, m } = setup();
    await started(m);
    for (let i = 0; i < 3; i++) {
      button(m.all(), en("pipeline.action.handOff"))!.props.onClick();
      await flush(m);
    }
    const waiting = m.all();
    expect(stages(waiting).map((s) => s.props["data-status"])).toEqual(["passed", "passed", "waiting"]);
    expect(textOf(status(waiting))).toBe(en("pipeline.announce.waiting", { stage: en("pipeline.preset.review") }));
    const spy = vi.spyOn(api, "pipelineDecide");
    button(waiting, en("pipeline.action.approve"))!.props.onClick();
    expect(spy).not.toHaveBeenCalled();
    dialog(m.all()).props.onConfirm();
    const done = await flush(m);
    expect(spy).toHaveBeenCalledWith(expect.any(String), true, null);
    expect(stages(done).every((s) => s.props["data-status"] === "passed")).toBe(true);
    expect(textOf(status(done))).toBe(en("pipeline.announce.done", { name: en("pipeline.preset.name") }));
  });

  it("declining an approval fails the stage without asking", async () => {
    const { m } = setup();
    await started(m);
    for (let i = 0; i < 3; i++) {
      button(m.all(), en("pipeline.action.handOff"))!.props.onClick();
      await flush(m);
    }
    button(m.all(), en("pipeline.action.decline"))!.props.onClick();
    const after = await flush(m);
    expect(stages(after).map((s) => s.props["data-status"])).toEqual(["passed", "passed", "failed"]);
    expect(button(after, en("pipeline.action.retry"))).toBeDefined();
  });
});
