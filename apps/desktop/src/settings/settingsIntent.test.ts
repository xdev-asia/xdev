import { expect, it } from "vitest";
import { settingsIntent } from "./settingsIntent";

const at = { section: "keys", arg: "a", target: undefined, seq: 3 };

it("toggle on the place Settings already shows closes it", () => {
  expect(settingsIntent(at, true, { section: "keys", arg: "a", target: undefined }, true)).toEqual({ close: true });
});

it("without toggle the same place reopens it with a new seq", () => {
  expect(settingsIntent(at, true, { section: "keys", arg: "a" }, false)).toEqual({ close: false, at: { section: "keys", arg: "a", target: undefined, seq: 4 } });
});

it("toggle on another place, or while Settings is hidden, opens", () => {
  expect(settingsIntent(at, true, { section: "git" }, true)).toMatchObject({ close: false, at: { section: "git", seq: 4 } });
  expect(settingsIntent(at, false, { section: "keys", arg: "a" }, true)).toMatchObject({ close: false });
});
