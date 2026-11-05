import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/mockApi";
import { translate } from "@/i18n";
import type { QuotaAlert } from "@/api";
import { getToasts, pushToast, resetToastsForTests } from "./toastStore";
import { alertToastId, watchQuotaAlerts } from "./quotaAlerts";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const alert: QuotaAlert = { provider: "claude", account: "claude-2", window: "five_hour", threshold: 80, utilization: 81.4 };

let stop: (() => void) | null = null;
beforeEach(() => resetToastsForTests());
afterEach(() => {
  stop?.();
  stop = null;
  resetToastsForTests();
});

async function setup() {
  const api = createMockApi({});
  stop = watchQuotaAlerts({ api, t, toast: pushToast });
  await tick();
  return api;
}

it("shows an alert as a toast that stays, with the action to use another account", async () => {
  const api = await setup();
  api.__quotaAlert(alert);
  const [toast] = getToasts();
  expect(toast.id).toBe(alertToastId(alert));
  expect(toast.text).toBe(t("accounts.alert.text", { name: "claude-2", used: 81, window: t("accounts.window.five_hour") }));
  expect(toast.actions.map((a) => a.label)).toEqual([t("accounts.alert.useNext")]);
});

it("one toast per account, window and threshold", async () => {
  const api = await setup();
  api.__quotaAlert(alert);
  api.__quotaAlert(alert);
  api.__quotaAlert({ ...alert, threshold: 95 });
  expect(getToasts().map((x) => x.id)).toEqual([alertToastId(alert), alertToastId({ ...alert, threshold: 95 })]);
});

it("the action sets the default to the account routing picks, and says which", async () => {
  const api = await setup();
  const next = vi.spyOn(api, "accountUseNext");
  api.__quotaAlert(alert);
  getToasts()[0].actions[0].run();
  await tick();
  expect(next).toHaveBeenCalledWith("claude", "claude-2");
  expect((await api.accounts()).active).toEqual([{ provider: "claude", name: "claude-3" }]);
  expect(getToasts()).toEqual([{ id: alertToastId(alert), text: t("accounts.alert.switched", { name: "claude-3" }), actions: [] }]);
});

it("says so when there is no other account", async () => {
  const api = await setup();
  api.__quotaAlert({ ...alert, provider: "codex", account: "codex-1" });
  getToasts()[0].actions[0].run();
  await tick();
  expect(getToasts()[0].text).toBe(t("accounts.alert.noOther", { name: "codex-1" }));
});

it("stops listening when stopped", async () => {
  const api = await setup();
  stop!();
  stop = null;
  api.__quotaAlert(alert);
  expect(getToasts()).toEqual([]);
});
