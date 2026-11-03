import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Quota } from "../api";
import { translate } from "../i18n";
import { meterOf, WorkspaceFooter } from "./WorkspaceFooter";

vi.mock("../i18n", async (original) => ({ ...await original<typeof import("../i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

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
});

it("meter over 80 % uses the warn class; unknown state shows a dash", () => {
  const html = render([account("hot", [["five_hour", 81]]), account("calm", [["five_hour", 80]]), account("old", [], "unknown")]);
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

it("no quota yet renders no meters and no error", () => {
  for (const quota of [null, []]) {
    const html = render(quota);
    expect(html).not.toContain("ws-meter");
    expect(html).not.toContain("role=\"meter\"");
    expect(html).toContain("v0.3.0");
  }
});
