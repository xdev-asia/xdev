import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Checkbox, Field, IconButton, Select, Switch } from "@xdev-asia/ui";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import vi_ from "@/i18n/vi.json";
import { mount, textOf, type Node } from "@/kit/testHooks";
import { parsePercent, priorityOrder, RoutingSection } from "./RoutingSection";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const tr = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
type View = Awaited<ReturnType<typeof open>>;

async function open(api: Api = createMockApi({})) {
  const m = mount(RoutingSection as (p: { api: Api }) => ReactElement, () => ({ api }));
  await m.settle();
  await m.settle();
  return { api, m };
}
/** The nodes inside one provider's section. */
const part = (all: Node[], provider: string) => {
  const section = all.find((n) => n.type === "section" && n.props["data-provider"] === provider)!;
  return [section, ...(function walk(n: Node): Node[] { return [n.props.children].flat(Infinity).filter((c): c is Node => !!c && typeof c === "object" && "props" in c).flatMap((c) => [c, ...walk(c)]); })(section)];
};
const claude = (v: View) => part(v.m.all(), "claude");
const status = (v: View) => textOf(claude(v).find((n) => n.props["data-field"] === "routing-status")!);
const fields = (v: View) => claude(v).filter((n) => n.type === Field);

it("shows each provider with the policy, pool, alerts and auto-switch, Manual by default", async () => {
  const v = await open();
  const all = v.m.all();
  expect(all.filter((n) => n.type === "section").map((n) => n.props["data-provider"])).toEqual(["claude", "codex"]);
  const select = claude(v).find((n) => n.type === Select)!;
  expect(select.props.value).toBe("manual");
  expect(select.props.options.map((o: { label: string }) => o.label)).toEqual(["manual", "most_quota", "round_robin", "priority"].map((p) => tr(`settings.account.routing.policy.${p}`)));
  expect(claude(v).filter((n) => n.type === Checkbox).map((n) => [n.props.label, n.props.checked])).toEqual([["claude-2", true], ["claude-3", true], ["old", true]]);
  expect(fields(v).map((n) => n.props.value)).toEqual(["80", "95", "95"]);
  const sw = claude(v).find((n) => n.type === Switch)!;
  expect([sw.props.checked, sw.props.label]).toEqual([false, tr("settings.account.routing.autoSwitch", { percent: 95 })]);
  expect(sw.props.label).toBe("When an account reaches 95%, start new agents on another account");
  expect(claude(v).some((n) => n.type === "p" && textOf(n) === tr("settings.account.routing.terms"))).toBe(true);
  // No priority list unless the policy is Priority order.
  expect(claude(v).some((n) => n.type === IconButton)).toBe(false);
});

it("picking a policy saves it and says so", async () => {
  const v = await open();
  const set = vi.spyOn(v.api, "accountRoutingSet");
  claude(v).find((n) => n.type === Select)!.props.onChange({ target: { value: "most_quota" } });
  await v.m.settle();
  expect(set).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude", policy: "most_quota" }));
  expect((await v.api.accountsRouting())[0].policy).toBe("most_quota");
  expect(claude(v).find((n) => n.type === Select)!.props.value).toBe("most_quota");
  expect(status(v)).toBe(tr("settings.account.routing.saved"));
});

it("the pool keeps at least one account, and all of them is stored as every account", async () => {
  const v = await open();
  claude(v).find((n) => n.type === Checkbox && n.props.label === "old")!.props.onChange({ target: { checked: false } });
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].pool).toEqual(["claude-2", "claude-3"]);
  claude(v).find((n) => n.type === Checkbox && n.props.label === "claude-2")!.props.onChange({ target: { checked: false } });
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].pool).toEqual(["claude-3"]);
  const last = claude(v).find((n) => n.type === Checkbox && n.props.label === "claude-3")!;
  expect([last.props.disabled, last.props.hint]).toEqual([true, tr("settings.account.routing.poolLast")]);
  claude(v).find((n) => n.type === Checkbox && n.props.label === "claude-2")!.props.onChange({ target: { checked: true } });
  await v.m.settle();
  claude(v).find((n) => n.type === Checkbox && n.props.label === "old")!.props.onChange({ target: { checked: true } });
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].pool).toEqual([]);
});

it("the priority order moves by keyboard buttons, keeps focus on the moved account, and announces it", async () => {
  const v = await open();
  claude(v).find((n) => n.type === Select)!.props.onChange({ target: { value: "priority" } });
  await v.m.settle();
  const buttons = () => claude(v).filter((n) => n.type === IconButton);
  expect(buttons().map((b) => [b.props.label, b.props.disabled])).toEqual([
    [tr("settings.account.routing.moveUp", { name: "claude-2" }), true],
    [tr("settings.account.routing.moveDown", { name: "claude-2" }), false],
    [tr("settings.account.routing.moveUp", { name: "claude-3" }), false],
    [tr("settings.account.routing.moveDown", { name: "claude-3" }), false],
    [tr("settings.account.routing.moveUp", { name: "old" }), false],
    [tr("settings.account.routing.moveDown", { name: "old" }), true],
  ]);
  // Hand the buttons real-ish elements, as React would through the refs.
  const focused: string[] = [];
  for (const b of buttons()) b.props.ref({ focus: () => focused.push(b.props.label) });
  buttons()[2].props.onClick();
  await v.m.settle();
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].priority).toEqual(["claude-3", "claude-2", "old"]);
  // claude-3 is now first, so its up button is disabled; focus goes to its down button.
  expect(focused).toEqual([tr("settings.account.routing.moveDown", { name: "claude-3" })]);
  expect(status(v)).toBe(tr("settings.account.routing.moved", { name: "claude-3", position: 1 }));
  const list = claude(v).find((n) => n.type === "ol")!;
  expect(list.props["aria-labelledby"]).toBe("routing-claude-priority");
});

it("alert thresholds save on Enter, sorted, and a bad percent shows an error and is not saved", async () => {
  const v = await open();
  const set = vi.spyOn(v.api, "accountRoutingSet");
  fields(v)[0].props.onChange({ target: { value: "abc" } });
  await v.m.settle();
  expect(fields(v)[0].props.error).toBe(tr("settings.account.routing.percentError"));
  fields(v)[0].props.onBlur();
  expect(set).not.toHaveBeenCalled();
  fields(v)[0].props.onChange({ target: { value: "99" } });
  fields(v)[1].props.onChange({ target: { value: "70" } });
  await v.m.settle();
  fields(v)[1].props.onKeyDown({ key: "Enter" });
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].thresholds).toEqual([70, 99]);
  // The fields show the saved order; an empty second alert means one alert only.
  expect(fields(v).slice(0, 2).map((n) => n.props.value)).toEqual(["70", "99"]);
  fields(v)[1].props.onChange({ target: { value: "" } });
  await v.m.settle();
  fields(v)[1].props.onBlur();
  await v.m.settle();
  expect((await v.api.accountsRouting())[0].thresholds).toEqual([70]);
});

it("auto-switch is opt-in and its percent is part of the label", async () => {
  const v = await open();
  claude(v).find((n) => n.type === Switch)!.props.onChange({ target: { checked: true } });
  await v.m.settle();
  fields(v)[2].props.onChange({ target: { value: "90" } });
  await v.m.settle();
  fields(v)[2].props.onBlur();
  await v.m.settle();
  expect((await v.api.accountsRouting())[0]).toMatchObject({ autoSwitch: true, switchAt: 90 });
  expect(claude(v).find((n) => n.type === Switch)!.props.label).toBe(tr("settings.account.routing.autoSwitch", { percent: 90 }));
});

it("a refused save says why and shows what is saved", async () => {
  const v = await open();
  vi.spyOn(v.api, "accountRoutingSet").mockRejectedValueOnce({ code: "bad_routing" });
  claude(v).find((n) => n.type === Select)!.props.onChange({ target: { value: "round_robin" } });
  await v.m.settle();
  await v.m.settle();
  expect(status(v)).toBe(tr("error.bad_routing"));
  expect(claude(v).find((n) => n.type === Select)!.props.value).toBe("manual");
});

it("parsePercent takes whole numbers from 1 to 100", () => {
  expect(["1", " 80 ", "100", "0", "101", "8.5", "", "-5", "x"].map(parsePercent)).toEqual([1, 80, 100, null, null, null, null, null, null]);
});

it("priorityOrder keeps the saved order, then adds the other accounts in the pool", () => {
  const r = { provider: "claude" as const, policy: "priority" as const, pool: [], priority: ["c"], thresholds: [80, 95], autoSwitch: false, switchAt: 95 };
  expect(priorityOrder(r, ["a", "b", "c"])).toEqual(["c", "a", "b"]);
  expect(priorityOrder({ ...r, pool: ["a", "c"] }, ["a", "b", "c"])).toEqual(["c", "a"]);
});

it("has the routing strings in both languages", () => {
  const keys = Object.keys(en).filter((k) => k.startsWith("settings.account.routing."));
  expect(keys.length).toBeGreaterThan(20);
  for (const key of keys) expect(vi_).toHaveProperty([key]);
});
