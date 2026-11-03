import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import en from "@/i18n/en.json";
import viDict from "@/i18n/vi.json";
import { AccountsView } from "./AccountsView";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[], deps: [] as unknown[][] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useEffect: (effect: () => void, deps: unknown[]) => { hooks.effects.push(effect); hooks.deps.push(deps); },
}));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

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
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.deps = []; });

it("renders bars, reset text and state badges", async () => {
  const view = harness(); view.draw();
  const cleanup = hooks.effects[0](); await tick();
  const html = view.html();
  for (const percent of [12, 40, 75]) expect(html).toContain(`aria-valuenow="${percent}"`);
  expect(html).toContain("resets in 2 h 10 min");
  expect(html).toContain('data-state="reserve"');
  expect(html).toContain('data-state="logged_out"');
  expect(html).toContain('<span class="doc-subtitle">Keeps 30% of each account for you</span>');
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
  expect(view.html().match(/Add account/g)).toHaveLength(1);
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
it("reloads quota as soon as polling sees the login finish", async () => {
  vi.useFakeTimers();
  try {
    const view = harness(); view.draw(); const stopLoad = hooks.effects[0](); await tick();
    if (typeof stopLoad === "function") stopLoad();
    const signedIn = await view.api.accounts();
    vi.spyOn(view.api, "accounts").mockResolvedValue({ ...signedIn, accounts: signedIn.accounts.map(a => ({ ...a, status: { ...a.status, state: "logged_in" as const } })) });
    await view.button("Log in").props.onClick();
    view.draw(); const loadDeps = hooks.deps.at(-2); const stopPoll = hooks.effects.at(-1)!();
    await vi.advanceTimersByTimeAsync(3_000);
    if (typeof stopPoll === "function") stopPoll();
    view.draw();
    // Changed deps are what make React rerun the load effect, which fetches quota.
    expect(hooks.deps.at(-2)).not.toEqual(loadDeps);
  } finally { vi.useRealTimers(); }
});
it("keeps null and extra windows visible without inventing a percent", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "quota").mockResolvedValue([{ name: "claude-2", state: "unknown", reason: null, windows: [{ key: "seven_day_opus", utilization: null, resetsAt: null }], asOf: null }]);
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
  expect((await view.api.accounts()).accounts.find(a => a.name === "new-account")!.provider).toBe("claude");
});

it("shows a Codex card with its provider and how fresh its quota is", async () => {
  const view = harness(); view.draw();
  const cleanup = hooks.effects[0](); await tick();
  const asOf = (await view.api.quota()).find(q => q.name === "codex-1")!.asOf!;
  const card = nodes(view.draw()).find(n => n.type === "section" && n.props["aria-label"] === "codex-1")!;
  const html = renderToStaticMarkup(card);
  expect(html).toContain('data-provider="codex"');
  expect(html).toContain(">Codex<");
  expect(html).toContain(translate("en", "accounts.asOf", { time: new Date(asOf).toLocaleString() }));
  expect(html).toContain('aria-valuenow="37"');
  // Claude quota is live, so its cards carry no "as of" note.
  const claude = renderToStaticMarkup(nodes(view.draw()).find(n => n.type === "section" && n.props["aria-label"] === "claude-2")!);
  expect(claude).toContain('data-provider="claude"');
  expect(claude).not.toContain("account-as-of");
  if (typeof cleanup === "function") cleanup();
});

it("explains a Codex account without sessions", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "quota").mockResolvedValue([{ name: "codex-1", state: "unknown", reason: "no_sessions", windows: [], asOf: null }]);
  const view = harness(api); view.draw(); const cleanup = hooks.effects[0](); await tick();
  expect(view.html()).toContain(translate("en", "accounts.reason.no_sessions"));
  if (typeof cleanup === "function") cleanup();
});

it("adds a Codex account with the chosen provider", async () => {
  const view = harness();
  const login = vi.spyOn(view.api, "loginAccount");
  view.button("Add account").props.onClick();
  const options = nodes(view.draw()).filter(n => n.type === "option").map(n => [n.props.value, n.props.children]);
  expect(options).toEqual([["claude", "Claude Code"], ["codex", "Codex"]]);
  nodes(view.draw()).find(n => n.type === "input")!.props.onChange({ target: { value: "cx" } });
  nodes(view.draw()).find(n => n.type === "select")!.props.onChange({ target: { value: "codex" } });
  await nodes(view.draw()).find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect((await view.api.accounts()).accounts.find(a => a.name === "cx")!.provider).toBe("codex");
  expect(login).toHaveBeenCalledWith("cx");
  expect(view.html()).toContain("CODEX_HOME=");
});
it("imports an existing folder, names it after the folder and skips the login", async () => {
  const view = harness(); view.draw(); const cleanup = hooks.effects[0](); await tick();
  const hive = String.raw`C:\Users\a\.xdev-hive\accounts\codex-3`;
  vi.spyOn(view.api, "pickFolder").mockResolvedValue(hive);
  const add = vi.spyOn(view.api, "addAccount"); const login = vi.spyOn(view.api, "loginAccount");
  view.button("Import folder").props.onClick();
  expect(view.html()).toContain(en["accounts.importHint"]);
  await view.button("Browse…").props.onClick(); await tick();
  await nodes(view.draw()).find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} }); await tick();
  expect(add).toHaveBeenCalledWith("codex-3", "codex", hive);
  expect(login).not.toHaveBeenCalled();
  expect(view.html()).not.toContain(en["accounts.importHint"]);
  if (typeof cleanup === "function") cleanup();
});
it("asks for a folder before importing", async () => {
  const view = harness(); const add = vi.spyOn(view.api, "addAccount");
  view.button("Import folder").props.onClick();
  nodes(view.draw()).filter(n => n.type === "input")[1].props.onChange({ target: { value: "h" } });
  await nodes(view.draw()).find(n => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  expect(view.html()).toContain(translate("en", "error.not_found"));
  expect(add).not.toHaveBeenCalled();
});
