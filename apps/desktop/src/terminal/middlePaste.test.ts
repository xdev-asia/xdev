import { expect, it } from "vitest";
import { middlePasteText, type MiddlePasteInput } from "./middlePaste";

const base: MiddlePasteInput = { enabled: true, platform: "linux", button: 1, tracking: false, selection: "ls -la" };

it("pastes the selection on a middle click on Linux", () => {
  expect(middlePasteText(base)).toBe("ls -la");
});

it("does nothing when off, on other platforms, on other buttons, with mouse tracking or no selection", () => {
  expect(middlePasteText({ ...base, enabled: false })).toBeNull();
  expect(middlePasteText({ ...base, platform: "win" })).toBeNull();
  expect(middlePasteText({ ...base, platform: "mac" })).toBeNull();
  expect(middlePasteText({ ...base, button: 0 })).toBeNull();
  expect(middlePasteText({ ...base, button: 2 })).toBeNull();
  expect(middlePasteText({ ...base, tracking: true })).toBeNull();
  expect(middlePasteText({ ...base, selection: "" })).toBeNull();
});
