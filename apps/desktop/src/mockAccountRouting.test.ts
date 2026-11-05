import { expect, it } from "vitest";
import { createMockApi } from "./mockApi";
import { defaultRouting, pickAccount, type Route } from "./mockAccountRouting";

const route = (over: Partial<Route> = {}): Route => ({ policy: "most_quota", default: "a", priority: [], limit: null, ...over });
const use = (pairs: [string, number | null][]) => pairs.map(([id, used]) => ({ id, used }));

it("pickAccount keeps the default for an empty pool and for Manual under its limit", () => {
  expect(pickAccount(route(), [], [], null)).toBe("a");
  expect(pickAccount(route({ policy: "manual" }), ["a", "b"], use([["a", 99], ["b", 1]]), null)).toBe("a");
  expect(pickAccount(route({ policy: "manual", limit: 90 }), ["a", "b"], use([["a", 95], ["b", 1]]), null)).toBe("b");
});

it("pickAccount: most quota left, ties to the default, unknown usage last", () => {
  expect(pickAccount(route(), ["b", "a"], use([["a", 10], ["b", 10]]), null)).toBe("a");
  expect(pickAccount(route(), ["a", "b"], use([["a", null], ["b", 50]]), null)).toBe("b");
  expect(pickAccount(route(), ["a", "b"], use([["a", 100], ["b", 100]]), null)).toBe("a");
});

it("pickAccount: round robin and priority skip accounts over their limit", () => {
  expect(pickAccount(route({ policy: "round_robin" }), ["a", "b", "c"], use([["b", 100]]), "a")).toBe("c");
  expect(pickAccount(route({ policy: "round_robin" }), ["a", "b"], [], null)).toBe("a");
  expect(pickAccount(route({ policy: "priority", priority: ["c", "b"] }), ["a", "b", "c"], use([["c", 100]]), null)).toBe("b");
});

it("routing defaults to Manual, alerts at 80 and 95, auto-switch off", async () => {
  const api = createMockApi({});
  expect(await api.accountsRouting()).toEqual([defaultRouting("claude"), defaultRouting("codex")]);
  expect(defaultRouting("claude")).toMatchObject({ policy: "manual", thresholds: [80, 95], autoSwitch: false });
});

it("saving checks the accounts and percents, and sorts the thresholds", async () => {
  const api = createMockApi({});
  const base = defaultRouting("claude");
  await expect(api.accountRoutingSet({ ...base, pool: ["codex-1"] })).rejects.toEqual({ code: "bad_routing" });
  await expect(api.accountRoutingSet({ ...base, thresholds: [0] })).rejects.toEqual({ code: "bad_routing" });
  await expect(api.accountRoutingSet({ ...base, priority: ["claude-3", "claude-3"] })).rejects.toEqual({ code: "bad_routing" });
  await api.accountRoutingSet({ ...base, policy: "most_quota", thresholds: [95, 70] });
  expect((await api.accountsRouting())[0]).toMatchObject({ policy: "most_quota", thresholds: [70, 95] });
});

it("a new agent with no account of its own starts where routing points, and says it was routed", async () => {
  const api = createMockApi({});
  await api.ptyApprove("claude", null);
  const first = await api.ptySpawn("p1", "/demo/wt/xdev-oak", "claude", null, 80, 24, () => {});
  expect([first.account, first.accountSource]).toEqual(["claude-2", "active"]);
  await api.accountRoutingSet({ ...defaultRouting("claude"), policy: "round_robin" });
  await api.ptyApprove("claude", null);
  const second = await api.ptySpawn("p2", "/demo/wt/xdev-oak", "claude", null, 80, 24, () => {});
  expect([second.account, second.accountSource]).toEqual(["claude-3", "routed"]);
  // A tab's own account is never routed.
  await api.ptyApprove("claude", null);
  const own = await api.ptySpawn("p3", "/demo/wt/xdev-oak", "claude", "claude-3", 80, 24, () => {});
  expect(own.accountSource).toBe("tab");
});

it("use next avoids the account, skips signed-out ones, and gives null when none is left", async () => {
  const api = createMockApi({});
  expect(await api.accountUseNext("claude", "claude-2")).toBe("claude-3");
  expect(await api.accountUseNext("codex", "codex-1")).toBeNull();
  await api.removeAccount("claude-2");
  expect(await api.accountUseNext("claude", "claude-3")).toBeNull();
});
