import type { ReactElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { SwarmPanel, type SwarmPanelProps } from "./SwarmPanel";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const Panel = SwarmPanel as unknown as (p: SwarmPanelProps) => ReactElement;

function setup() {
  const api = createMockApi({});
  const m = mount(Panel, () => ({ api, worktree: "/w", pollMs: 3_600_000 }));
  return { api, m };
}

const input = (all: Node[], pick: (n: Node) => boolean) => all.find((n) => n.type === "input" && pick(n))!;
const goal = (all: Node[]) => input(all, (n) => n.props.type === undefined);
const count = (all: Node[]) => input(all, (n) => n.props.type === "number");
const rows = (all: Node[]) => all.filter((n) => n.type === "li" && n.props.className === "swarm-row");
const status = (all: Node[]) => all.find((n) => n.props.role === "status")!;
const dialog = (all: Node[]) => all.find((n) => "confirmLabel" in n.props)!;
const flush = async (m: ReturnType<typeof mount>) => {
  await m.settle();
  return m.settle();
};

async function start(m: ReturnType<typeof mount>, text = "Port the parser") {
  await m.settle();
  goal(m.all()).props.onChange({ target: { value: text } });
  m.all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  return flush(m);
}

describe("SwarmPanel", () => {
  it("starts with a count of 4 and cannot start without a goal", async () => {
    const { m } = setup();
    const all = await m.settle();
    expect(count(all).props.value).toBe("4");
    expect(count(all).props.max).toBe(12);
    const submit = all.find((n) => n.type === "button" && n.props.type === "submit")!;
    expect(submit.props.disabled).toBe(true);
  });

  it("lists the workers with their status and last line, and announces the start", async () => {
    const { api, m } = setup();
    const spy = vi.spyOn(api, "swarmStart");
    const all = await start(m);
    expect(spy).toHaveBeenCalledWith("Port the parser", 4, "claude", null, "/w");
    expect(rows(all)).toHaveLength(4);
    const first = rows(all)[0];
    expect(first.props["aria-label"]).toBe(en("swarm.worker", { n: 1 }));
    expect(textOf(first)).toContain(en("swarm.state.ready"));
    expect(textOf(first)).toContain("Working on part 1 of 4");
    expect(textOf(status(all))).toBe(en("swarm.announce.started", { count: 4 }));
  });

  it("holds the count to 12", async () => {
    const { api, m } = setup();
    const spy = vi.spyOn(api, "swarmStart");
    await m.settle();
    count(m.all()).props.onChange({ target: { value: "40" } });
    await start(m);
    expect(spy.mock.calls[0][1]).toBe(12);
    expect(rows(m.all())).toHaveLength(12);
  });

  it("opens one worker as a tab and marks it opened", async () => {
    const { api, m } = setup();
    await m.settle();
    count(m.all()).props.onChange({ target: { value: "3" } });
    const all = await start(m);
    expect(rows(all)).toHaveLength(3);
    const buttons = m.all().filter((n) => n.type === "button" && n.props["aria-label"] === en("swarm.openLabel", { name: en("swarm.worker", { n: 2 }) }));
    buttons[0].props.onClick();
    const after = await flush(m);
    expect(api.__swarmOpened()).toHaveLength(1);
    expect(textOf(rows(after)[1])).toContain(en("swarm.opened"));
    expect(textOf(rows(after)[0])).not.toContain(en("swarm.opened"));
  });

  it("stop all asks first, then stops every worker", async () => {
    const { api, m } = setup();
    await start(m);
    const spy = vi.spyOn(api, "swarmStopAll");
    m.all().find((n) => n.type === "button" && n.props.children === en("swarm.stopAll"))!.props.onClick();
    expect(spy).not.toHaveBeenCalled();
    const asking = m.all();
    expect(dialog(asking).props.open).toBe(true);
    expect(dialog(asking).props.body).toBe(en("swarm.confirmStop.body", { count: 4 }));
    dialog(asking).props.onConfirm();
    const after = await flush(m);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(textOf(status(after))).toBe(en("swarm.announce.stopped", { count: 4 }));
    expect(rows(after).every((r) => r.props["data-state"] === "stopped")).toBe(true);
  });

  it("cancelling stop all stops nothing", async () => {
    const { api, m } = setup();
    await start(m);
    const spy = vi.spyOn(api, "swarmStopAll");
    m.all().find((n) => n.type === "button" && n.props.children === en("swarm.stopAll"))!.props.onClick();
    dialog(m.all()).props.onCancel();
    expect(dialog(m.all()).props.open).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});
