import { expect, it } from "vitest";
import { buildOverrides, CUSTOM_MODEL, EMPTY_FORM } from "./launchOptions";

it("an untouched form changes nothing", () => {
  expect(buildOverrides(EMPTY_FORM, true)).toEqual({ overrides: null, badArgs: false });
  expect(buildOverrides({ ...EMPTY_FORM, args: "   " }, true).overrides).toBeNull();
});

it("a known model, an effort and split arguments become the overrides", () => {
  expect(buildOverrides({ model: "opus", customModel: "ignored", effort: "high", args: `--add-dir "a b"` }, true)).toEqual({
    overrides: { model: "opus", effort: "high", extraArgs: ["--add-dir", "a b"] },
    badArgs: false,
  });
});

it("the typed model is used when custom is chosen, trimmed", () => {
  expect(buildOverrides({ ...EMPTY_FORM, model: CUSTOM_MODEL, customModel: "  my-model " }, false).overrides).toEqual({ model: "my-model", effort: null, extraArgs: [] });
  expect(buildOverrides({ ...EMPTY_FORM, model: CUSTOM_MODEL, customModel: " " }, false).overrides).toBeNull();
});

it("an agent without effort drops it", () => {
  expect(buildOverrides({ ...EMPTY_FORM, effort: "high" }, false).overrides).toBeNull();
});

it("an open quote is flagged and sends no arguments", () => {
  expect(buildOverrides({ ...EMPTY_FORM, model: "opus", args: `--x "oops` }, true)).toEqual({
    overrides: { model: "opus", effort: null, extraArgs: [] },
    badArgs: true,
  });
});
