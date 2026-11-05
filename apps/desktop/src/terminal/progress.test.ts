import { expect, it } from "vitest";
import { parseOsc9Progress } from "./progress";

it("reads OSC 9;4 progress", () => {
  expect(parseOsc9Progress("4;1;40")).toBe(40);
  expect(parseOsc9Progress("4;0")).toBeNull();
  expect(parseOsc9Progress("4;2;10")).toBe("keep");
  expect(parseOsc9Progress("4;3")).toBe("keep");
  expect(parseOsc9Progress("4;4;5")).toBe("keep");
  expect(parseOsc9Progress("4;1;150")).toBe(100);
});

it("ignores anything that is not 9;4", () => {
  expect(parseOsc9Progress("1;hello")).toBeUndefined();
  expect(parseOsc9Progress("hello")).toBeUndefined();
  expect(parseOsc9Progress("")).toBeUndefined();
  expect(parseOsc9Progress("4;9;1")).toBeUndefined();
  expect(parseOsc9Progress("4;1;abc")).toBeUndefined();
});
