import { beforeEach, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quota } from "@/api";
import { translate } from "@/i18n";
import { createMockApi } from "@/mockApi";
import { resetUsageSettingsForTests, setUsageSettings } from "@/settings/usageSettings";
import { USAGE_DEFAULTS } from "@/settings/usageDefaults";
import { LiveWorkspaceFooter, meterOf, WorkspaceFooter } from "./WorkspaceFooter";

// The live footer reads the quota and the update state through hooks; fixed values stand in for them.
const live = vi.hoisted(() => ({ quota: null as unknown }));
vi.mock("@/shell/useQuota", () => ({ useQuota: () => ({ quota: live.quota, loading: false, refresh() {} }) }));
vi.mock("@/shell/useUpdate", () => ({ useUpdate: () => ({ state: null, restart() {} }) }));

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const account = (name: string, windows: [string, number | null][], state: Quota["state"] = "ok"): Quota => ({
  name,
  state,
  reason: null,
  windows: windows.map(([key, utilization]) => ({ key, utilization, resetsAt: null })),
  asOf: null,
});
const render = (quota: Quota[] | null, extra: Partial<Parameters<typeof WorkspaceFooter>[0]> = {}) =>
  renderToStaticMarkup(WorkspaceFooter({ branch: "main", running: 0, waiting: 0, quota, version: "0.3.0", ...extra }));

it("shows branch, running and waiting counts and the version", () => {
  const html = render(null, { branch: "feat/x", running: 2, waiting: 1 });
  expect(html).toContain("⎇ feat/x");
  expect(html).toContain(en("workspace.footer.running", { count: 2 }));
  expect(html).toContain(en("workspace.footer.waiting", { count: 1 }));
  expect(html).toContain("v0.3.0");
  // No branch, no crumb; zero running shows no pulse.
  const bare = render(null, { branch: null });
  expect(bare).not.toContain("⎇");
  expect(bare).not.toContain("ws-pulse");
  expect(html).toContain("ws-pulse");
});

it("one meter per account with the busiest window", () => {
  const quota = [account("claude-2", [["five_hour", 10], ["seven_day", 42]]), account("codex-1", [["five_hour", 7]])];
  expect(meterOf(quota[0]!)).toEqual({ label: "claude-2", percent: 42, window: "seven_day" });
  const html = render(quota);
  expect(html.match(/role="meter"/g)).toHaveLength(2);
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="42"/);
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="7"/);
  expect(html).toContain("42%");
  expect(html).toContain("claude-2");
  // The meter group is one tab stop, so the footer is in the focus order.
  expect(html).toMatch(/class="ws-meters"[^>]*tabindex="0"/);
});

it("meter at 80 % or more uses the warn class; unknown state shows a dash", () => {
  const html = render([account("hot", [["five_hour", 80]]), account("calm", [["five_hour", 79]]), account("old", [], "unknown")]);
  const meters = html.split(/<span class="ws-meter(?=[ "])/).slice(1);
  expect(meters).toHaveLength(3);
  expect(meters[0]).toMatch(/^ ws-meter-warn"/);
  expect(meters[1]).not.toMatch(/^ ws-meter-warn/);
  expect(meters[2]).not.toMatch(/^ ws-meter-warn/);
  // The unknown account has a dash and no meter bar.
  expect(meters[2]).toContain("–");
  expect(meters[2]).not.toContain('role="meter"');
  expect(meterOf(account("old", [], "unknown")).percent).toBeNull();
  // A known account with no readable window is a dash too.
  expect(meterOf(account("blank", [["five_hour", null]])).percent).toBeNull();
});

it("a ready update shows a restart button with the new version; none without one", () => {
  expect(render(null)).not.toContain("ws-update");
  expect(render(null, { update: null })).not.toContain("ws-update");
  const html = render(null, { update: { version: "0.4.0", notes: "Faster diffs", status: "ready" } });
  expect(html).toMatch(/<button type="button" class="ws-update"[^>]*title="Faster diffs"/);
  expect(html).toContain(en("workspace.footer.update", { version: "0.4.0" }));
  // The build version stays next to it.
  expect(html).toContain("v0.3.0");
});

it("restarting shows progress with no button; a failed restart offers a retry", () => {
  const busy = render(null, { update: { version: "0.4.0", notes: null, status: "restarting" } });
  expect(busy).toContain(en("status.updating"));
  expect(busy).not.toContain("<button");
  const failed = render(null, { update: { version: "0.4.0", notes: null, status: "failed" } });
  expect(failed).toMatch(/<button type="button" class="ws-update"/);
  expect(failed).toContain(en("status.updateFailed"));
});

it("no quota yet renders no meters and no error", () => {
  for (const quota of [null, []]) {
    const html = render(quota);
    expect(html).not.toContain("ws-meter");
    expect(html).not.toContain("role=\"meter\"");
    expect(html).toContain("v0.3.0");
  }
});

it("with a toggle the meters are one button; aria-expanded follows the popover", () => {
  const quota = [account("claude-2", [["five_hour", 10]])];
  const closed = render(quota, { onToggleUsage: () => {}, usagePopover: "POPOVER" });
  expect(closed).toMatch(/<button type="button" class="ws-meters ws-meters-btn"[^>]*data-action="usage"/);
  expect(closed).toMatch(/data-action="usage"[^>]*aria-expanded="false"/);
  expect(closed).not.toContain("POPOVER");
  // The meter group is no longer a second tab stop.
  expect(closed).not.toMatch(/class="ws-meters"[^>]*tabindex/);
  const open = render(quota, { onToggleUsage: () => {}, usageOpen: true, usagePopover: "POPOVER" });
  expect(open).toMatch(/data-action="usage"[^>]*aria-expanded="true"/);
  expect(open).toContain("POPOVER");
});

it("the old token usage link stays next to the meter button", () => {
  const html = render([account("a", [["five_hour", 1]])], { onToggleUsage: () => {}, onOpenUsage: () => {} });
  expect(html).toContain('data-action="token-usage"');
  expect(html).toContain('data-action="usage"');
});

it("no meters, no usage button", () => {
  expect(render(null, { onToggleUsage: () => {} })).not.toContain('data-action="usage"');
});

it("Remaining shows what is left: 30 % for 70 % used, in the number, the bar and the title", () => {
  const html = render([account("claude-2", [["five_hour", 70]])], { display: "remaining" });
  expect(html).toContain("30%");
  expect(html).not.toContain("70%");
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="30"/);
  expect(html).toMatch(/class="ws-meter-fill" style="width:30%"/);
  expect(html).toContain(en("workspace.footer.meterTitle", { name: "claude-2", window: en("workspace.footer.window.five_hour"), percent: 30, state: en("usage.stats.left") }));
  const used = render([account("claude-2", [["five_hour", 70]])]);
  expect(used).toContain("70%");
  expect(used).toContain(en("usage.stats.used"));
});

it("the warning stays on 80 % used in both modes: 85 % used warns in Remaining, 79 % does not", () => {
  const hot = render([account("hot", [["five_hour", 85]])], { display: "remaining" });
  expect(hot).toContain("ws-meter-warn");
  expect(hot).toContain("15%");
  expect(render([account("calm", [["five_hour", 79]])], { display: "remaining" })).not.toContain("ws-meter-warn");
});

it("a meter past 100 % used shows 0 % left", () => {
  const html = render([account("over", [["five_hour", 130]])], { display: "remaining" });
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="0"/);
  expect(html).toContain("0%");
});

const renderLive = (hidden = false) =>
  renderToStaticMarkup(createElement(LiveWorkspaceFooter, { api: createMockApi({}), branch: "main", running: 0, waiting: 0, version: "0.3.0", hidden }));

beforeEach(() => {
  resetUsageSettingsForTests();
  live.quota = [account("claude-1", [["five_hour", 33]]), account("codex-1", [["five_hour", 7]])];
});

it("the live footer shows a meter for each account from the live quota", () => {
  const html = renderLive();
  expect(html.match(/role="meter"/g)).toHaveLength(2);
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="33"/);
  expect(html).toContain("v0.3.0");
});

it("the live footer shows remaining instead of used when the display setting says so", () => {
  setUsageSettings({ ...USAGE_DEFAULTS, display: "remaining" });
  const html = renderLive();
  expect(html).toMatch(/role="meter"[^>]*aria-valuenow="67"/);
});

it("hides each item when its switch is off, and keeps the rest", () => {
  const all = { branch: true, tokenUsage: true, agents: true, version: true, ports: true };
  const full = render(null, { branch: "feat/x", running: 1, waiting: 1, onOpenUsage() {}, items: all });
  expect(full).toContain("⎇ feat/x");
  expect(full).toContain('data-action="token-usage"');
  expect(full).toContain("ws-running");
  expect(full).toContain("v0.3.0");

  const off = (k: keyof typeof all) => render(null, { branch: "feat/x", running: 1, waiting: 1, onOpenUsage() {}, items: { ...all, [k]: false } });
  expect(off("branch")).not.toContain("⎇");
  expect(off("branch")).toContain("v0.3.0");
  expect(off("tokenUsage")).not.toContain('data-action="token-usage"');
  expect(off("agents")).not.toContain("ws-running");
  expect(off("agents")).not.toContain("ws-waiting");
  expect(off("version")).not.toContain("v0.3.0");
  expect(off("version")).toContain("ws-running");
});

it("shows the ports item before the version, unless its switch is off", () => {
  const all = { branch: true, tokenUsage: true, agents: true, version: true, ports: true };
  const ports = <button data-action="show-ports" />;
  const on = render(null, { ports, items: all });
  expect(on).toContain('data-action="show-ports"');
  expect(on.indexOf("show-ports")).toBeLessThan(on.indexOf("v0.3.0"));
  expect(render(null, { ports, items: { ...all, ports: false } })).not.toContain("show-ports");
  expect(render(null, { items: all })).not.toContain("show-ports");
});

it("shows the update notice even with every item off", () => {
  const none = { branch: false, tokenUsage: false, agents: false, version: false, ports: false };
  const html = render(null, { items: none, update: { status: "ready", version: "9.9.9", notes: null } as never });
  expect(html).toContain("ws-update");
  expect(html).not.toContain("⎇");
});

it("shows the keep-awake item before the version", () => {
  const html = render(null, { keepAwake: createElement("span", { id: "awake" }) });
  expect(html.indexOf('id="awake"')).toBeGreaterThan(-1);
  expect(html.indexOf('id="awake"')).toBeLessThan(html.indexOf("v0.3.0"));
  expect(render(null)).not.toContain('id="awake"');
});

// Walks a React element tree (the footer called as a function) for the first element with `data-action`.
type El = { props?: { children?: unknown; [k: string]: unknown } };
function findAction(node: unknown, action: string): El | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) { const f = findAction(n, action); if (f) return f; }
    return null;
  }
  const el = node as El;
  if (el.props?.["data-action"] === action) return el;
  return findAction(el.props?.children, action);
}
const tree = (quota: Quota[] | null, extra: Partial<Parameters<typeof WorkspaceFooter>[0]> = {}) =>
  WorkspaceFooter({ branch: "main", running: 0, waiting: 0, quota, version: "0.3.0", ...extra });

it("right-click on the meters button opens the menu at the pointer", () => {
  const onMetersMenu = vi.fn();
  const preventDefault = vi.fn();
  const button = findAction(tree([account("a", [["five_hour", 1]])], { onToggleUsage() {}, onMetersMenu }), "usage");
  (button!.props!.onContextMenu as (e: unknown) => void)({ preventDefault, clientX: 5, clientY: 6 });
  expect(preventDefault).toHaveBeenCalled();
  expect(onMetersMenu).toHaveBeenCalledWith({ x: 5, y: 6 });
});

it("right-click on the plain meter group does the same", () => {
  const onMetersMenu = vi.fn();
  const preventDefault = vi.fn();
  const root = tree([account("a", [["five_hour", 1]])], { onMetersMenu }) as unknown as El;
  const kids = (root.props!.children as unknown[]).flat() as (El | false | null)[];
  const group = kids.find((k) => k && (k.props as { role?: string } | undefined)?.role === "group") as El;
  (group.props!.onContextMenu as (e: unknown) => void)({ preventDefault, clientX: 1, clientY: 2 });
  expect(onMetersMenu).toHaveBeenCalledWith({ x: 1, y: 2 });
  expect(preventDefault).toHaveBeenCalled();
});

it("without a menu handler the meters take no context handler", () => {
  const button = findAction(tree([account("a", [["five_hour", 1]])], { onToggleUsage() {} }), "usage");
  expect(button!.props!.onContextMenu).toBeUndefined();
});

it("an open menu renders after the popover", () => {
  const html = render([account("a", [["five_hour", 1]])], { onToggleUsage() {}, usageOpen: true, usagePopover: "POPOVER", menu: "MENU" });
  expect(html.indexOf("MENU")).toBeGreaterThan(html.indexOf("POPOVER"));
});
