import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "../api";
import { translate } from "../i18n";
import en from "../i18n/en.json";
import viDict from "../i18n/vi.json";
import { AccountsView } from "./AccountsView";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness(api = createMockApi({})) {
  const draw = () => { hooks.cursor = 0; return AccountsView({ api }); };
  const html = () => renderToStaticMarkup(draw());
  const button = (text: string) => nodes(draw()).find(n => n.props.children === text && n.props.onClick)!;
  return { api, draw, html, button };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("renders bars, reset text and state badges", async () => {
  const view = harness(); view.draw();
  const cleanup = hooks.effects[0](); await tick();
  const html = view.html();
  for (const percent of [12, 40, 75]) expect(html).toContain(`aria-valuenow="${percent}"`);
  expect(html).toContain("resets in 2 h 10 min");
  expect(html).toContain('data-state="reserve"');
  expect(html).toContain('data-state="logged_out"');
  if (typeof cleanup === "function") cleanup();
});
it("rejects an invalid inline name before calling the API", async () => {
  const view = harness(); const add = vi.spyOn(view.api, "addAccount");
  view.button("Add account").props.onClick();
  nodes(view.draw()).find(n => n.type === "input")!.props.onChange({ target: { value: "A b" } });
  await nodes(view.draw()).find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(view.html()).toContain(translate("en", "error.bad_name"));
  expect(add).not.toHaveBeenCalled();
});
it("confirms removal with the kept folder and supports login command copy", async () => {
  const view = harness(); view.draw(); const cleanup = hooks.effects[0](); await tick();
  const remove = vi.spyOn(view.api, "removeAccount");
  view.button("Remove").props.onClick();
  expect(remove).not.toHaveBeenCalled();
  expect(view.html()).toContain("/demo/accounts/claude-2");
  await view.button("Confirm removal").props.onClick(); await tick();
  expect(remove).toHaveBeenCalledWith("claude-2");
  await view.button("Log in").props.onClick(); await tick();
  expect(view.html()).toContain("claude auth login");
  expect(view.button("Copy")).toBeDefined();
  if (typeof cleanup === "function") cleanup();
});
it("shows the empty state", async () => {
  const api = createMockApi({}); for (const a of (await api.accounts()).accounts) await api.removeAccount(a.name);
  const view = harness(api); view.draw(); const cleanup = hooks.effects[0](); await tick();
  expect(view.html()).toContain("No accounts yet");
  if (typeof cleanup === "function") cleanup();
});
describe("account translations", () => {
  it("has matching keys and localized reset units", () => {
    for (const key of Object.keys(en).filter(k => k.startsWith("accounts."))) expect(viDict).toHaveProperty(key);
    expect(translate("vi", "accounts.resets", { hours: 2, minutes: 10 })).toBe("Đặt lại sau 2 giờ 10 phút");
  });
});

it("refreshes quota every five minutes and stops on close", async () => {
  vi.useFakeTimers();
  try {
    const view = harness(); const quota = vi.spyOn(view.api, "quota");
    view.draw(); const cleanup = hooks.effects[0](); await tick();
    await vi.advanceTimersByTimeAsync(299_999);
    expect(quota).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(quota).toHaveBeenCalledTimes(2);
    if (typeof cleanup === "function") cleanup();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(quota).toHaveBeenCalledTimes(2);
  } finally { vi.useRealTimers(); }
});
it("polls only status after login, stops after five minutes and on close", async () => {
  vi.useFakeTimers();
  try {
    const view = harness(); view.draw(); const stopLoad = hooks.effects[0](); await tick();
    const accounts = vi.spyOn(view.api, "accounts"); const quota = vi.spyOn(view.api, "quota");
    await view.button("Log in").props.onClick();
    view.draw(); const stopPoll = hooks.effects.at(-1)!();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(accounts).toHaveBeenCalledTimes(1);
    expect(quota).not.toHaveBeenCalled();
    if (typeof stopLoad === "function") stopLoad();
    await vi.advanceTimersByTimeAsync(300_000);
    const count = accounts.mock.calls.length;
    await vi.advanceTimersByTimeAsync(9_000);
    expect(accounts).toHaveBeenCalledTimes(count);
    if (typeof stopPoll === "function") stopPoll();
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});
it("keeps null and extra windows visible without inventing a percent", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "quota").mockResolvedValue([{ name: "claude-2", state: "unknown", reason: null, windows: [{ key: "seven_day_opus", utilization: null, resetsAt: null }] }]);
  const view = harness(api); view.draw(); const cleanup = hooks.effects[0](); await tick();
  expect(view.html()).toContain("seven_day_opus");
  expect(view.html()).toContain("Reset time unknown");
  expect(view.html()).not.toContain("NaN");
  if (typeof cleanup === "function") cleanup();
});

it("adds an account before starting login and hides commands when a console opens", async () => {
  const view = harness();
  const login = vi.spyOn(view.api, "loginAccount").mockResolvedValue({ opened: true, command: "claude auth login" });
  view.button("Add account").props.onClick();
  nodes(view.draw()).find(n => n.type === "input")!.props.onChange({ target: { value: "new-account" } });
  await nodes(view.draw()).find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect((await view.api.accounts()).accounts.some(a => a.name === "new-account")).toBe(true);
  expect(login).toHaveBeenCalledWith("new-account");
  expect(view.html()).not.toContain("claude auth login");
});
