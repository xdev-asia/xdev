import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quota } from "@/api";
import { translate } from "@/i18n";
import { meterOf, WorkspaceFooter } from "./WorkspaceFooter";

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
