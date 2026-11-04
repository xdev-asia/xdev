import { expect, it } from "vitest";
import { takeOnce } from "./takeOnce";

it("loads once and shares the answer", async () => {
  let calls = 0;
  const take = takeOnce(async () => ++calls);
  const [a, b] = await Promise.all([take(), take()]);
  expect([a, b, await take()]).toEqual([1, 1, 1]);
  expect(calls).toBe(1);
});
