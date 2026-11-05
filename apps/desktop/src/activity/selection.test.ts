import { expect, it } from "vitest";
import { clear, range, toggle } from "./selection";

const ids = ["a", "b", "c", "d", "e"];

it("toggle adds and removes an id without touching the old set", () => {
  const none: ReadonlySet<string> = new Set();
  const one = toggle(none, "a");
  expect([...one]).toEqual(["a"]);
  expect(none.size).toBe(0);
  expect([...toggle(one, "b")]).toEqual(["a", "b"]);
  expect([...toggle(one, "a")]).toEqual([]);
});

it("range picks the ids between the anchor and the id, in either direction", () => {
  expect([...range(ids, "b", "d")]).toEqual(["b", "c", "d"]);
  expect([...range(ids, "d", "b")]).toEqual(["b", "c", "d"]);
  expect([...range(ids, "c", "c")]).toEqual(["c"]);
});

it("range with a missing anchor or id falls back to the id alone", () => {
  expect([...range(ids, "gone", "c")]).toEqual(["c"]);
  expect([...range(ids, null, "c")]).toEqual(["c"]);
  expect([...range(ids, "a", "gone")]).toEqual([]);
});

it("clear gives an empty set", () => {
  expect(clear().size).toBe(0);
});
