import { expect, it } from "vitest";
import type { ApiError, LaunchVerdict } from "@/api";
import { translate } from "@/i18n";
import { failureCopy } from "./SpawnFailure";
import { wantsVerdict } from "@/agentLaunch/verdictCopy";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const error: ApiError = { code: "pty_spawn", detail: "No such file or directory (os error 2)" };

it("a missing program reads as an install hint, not the raw error", () => {
  const copy = failureCopy(t, "Claude Code", error, { kind: "notInstalled" });
  expect(copy.text).toBe(t("agentLaunch.verdict.notInstalled", { agent: "Claude Code" }));
  expect(copy.text).toContain("Install");
  expect(copy.detail).toBeNull();
});

it("an old version reads as an upgrade hint with both versions", () => {
  const copy = failureCopy(t, "Codex", error, { kind: "tooOld", found: "0.130.0", min: "0.136.0" });
  expect(copy.text).toContain("0.130.0");
  expect(copy.text).toContain("0.136.0");
  expect(copy.text).toContain("Upgrade");
});

it("a failed check keeps its short hint", () => {
  expect(failureCopy(t, "Gemini CLI", error, { kind: "failed", hint: "bad flag" }).text).toContain("bad flag");
  expect(failureCopy(t, "Gemini CLI", error, { kind: "failed", hint: "" }).text).toBe(t("agentLaunch.verdict.failed", { agent: "Gemini CLI" }));
});

it("a working program, or no verdict yet, keeps the error's own words and detail", () => {
  const ok: LaunchVerdict = { kind: "ok", version: "2.1.317" };
  for (const v of [ok, null]) {
    expect(failureCopy(t, "Claude Code", error, v)).toEqual({ text: t("error.pty_spawn"), detail: error.detail });
  }
});

it("only start failures ask for a verdict", () => {
  expect(wantsVerdict("pty_spawn")).toBe(true);
  expect(wantsVerdict("not_installed")).toBe(true);
  expect(wantsVerdict("denied")).toBe(false);
  expect(wantsVerdict("needs_approval")).toBe(false);
});

it("too many terminals reads as the cap message, with the cap as detail", () => {
  const copy = failureCopy(t, "", { code: "too_many_terminals", detail: "256" }, null);
  expect(copy.text).toBe(t("error.too_many_terminals"));
  expect(copy.text).toContain("Settings > Terminal > Advanced");
  expect(copy.detail).toBe("256");
});
