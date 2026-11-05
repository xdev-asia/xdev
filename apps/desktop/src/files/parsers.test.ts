import { expect, it } from "vitest";
import { ensureParsers } from "./parsers";

it("returns the same object while nothing new was loaded, so effects keyed on it do not rerun", async () => {
  const a = await ensureParsers([]);
  const b = await ensureParsers([]);
  expect(b).toBe(a);
});

it("returns a new object only when a language was added", async () => {
  const before = await ensureParsers([]);
  const withJson = await ensureParsers(["json"]);
  const again = await ensureParsers(["json"]);
  expect(again).toBe(withJson);
  expect(Object.keys(withJson)).toContain("json");
  expect(withJson).not.toBe(before);
});
