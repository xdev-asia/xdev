import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { STEPS, allowNotifications, flowReducer, initialFlow, isFirstStep, isLastStep, saveAnswers, type FlowState } from "./flowModel";

const run = (s: FlowState, ...types: ("next" | "back" | "askSkip" | "cancelSkip")[]) => types.reduce((acc, type) => flowReducer(acc, { type }), s);

it("walks forward and back and stops at both ends", () => {
  let s = initialFlow();
  expect(isFirstStep(s)).toBe(true);
  expect(run(s, "back").step).toBe(0);
  s = run(s, "next", "next", "next");
  expect(s.step).toBe(STEPS.length - 1);
  expect(isLastStep(s)).toBe(true);
  expect(run(s, "next").step).toBe(STEPS.length - 1);
  expect(run(s, "back").step).toBe(STEPS.length - 2);
});

it("merges answers and keeps them across steps", () => {
  let s = flowReducer(initialFlow({ agent: "claude" }), { type: "answer", answers: { theme: "dark" } });
  s = run(s, "next", "back");
  expect(s.answers).toEqual({ agent: "claude", theme: "dark" });
});

it("opens and closes the skip question without moving", () => {
  const s = run(initialFlow(), "next", "askSkip");
  expect(s).toMatchObject({ step: 1, asking: true });
  expect(run(s, "cancelSkip")).toMatchObject({ step: 1, asking: false });
});

it("Finish saves the default agent and shell through profilesDefaults and the theme through uiSettingsPut", async () => {
  const api = createMockApi({});
  const view = await api.profiles();
  const shell = view.shells[view.shells.length - 1]!.id;
  const defaults = vi.spyOn(api, "profilesDefaults");
  const put = vi.spyOn(api, "uiSettingsPut");
  const before = await api.uiSettingsGet();
  const theme = before.theme === "dark" ? "light" : "dark";
  await saveAnswers(api, { agent: "blank", shell, theme });
  expect(defaults).toHaveBeenCalledWith(view.approvals, "blank", shell);
  expect(put).toHaveBeenCalledWith({ ...before, theme });
  expect((await api.profiles()).defaultAgent).toBe("blank");
  expect((await api.uiSettingsGet()).theme).toBe(theme);
});

it("an unanswered step changes nothing", async () => {
  const api = createMockApi({});
  const defaults = vi.spyOn(api, "profilesDefaults");
  const put = vi.spyOn(api, "uiSettingsPut");
  await saveAnswers(api, { language: "vi" });
  expect(defaults).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
});

it("reports a rejected notification as denied", async () => {
  const sent = { notifyUpdate: vi.fn().mockResolvedValue(undefined) };
  expect(await allowNotifications(sent, "t", "b")).toBe("allowed");
  expect(sent.notifyUpdate).toHaveBeenCalledWith("t", "b");
  expect(await allowNotifications({ notifyUpdate: () => Promise.reject(new Error("no")) }, "t", "b")).toBe("denied");
});
