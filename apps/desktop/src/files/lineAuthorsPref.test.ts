import { expect, it } from "vitest";
import { createLineAuthorsPref, LINE_AUTHORS_KEY, type PrefStorage } from "./lineAuthorsPref";

function memory(initial?: string): PrefStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(initial === undefined ? [] : [[LINE_AUTHORS_KEY, initial]]);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
}

it("is on by default", () => {
  expect(createLineAuthorsPref(() => memory()).get()).toBe(true);
  expect(createLineAuthorsPref(() => null).get()).toBe(true);
});

it("reads a stored off and keeps a choice for a new store", () => {
  expect(createLineAuthorsPref(() => memory("false")).get()).toBe(false);
  const storage = memory();
  createLineAuthorsPref(() => storage).set(false);
  expect(storage.data.get(LINE_AUTHORS_KEY)).toBe("false");
  expect(createLineAuthorsPref(() => storage).get()).toBe(false);
});

it("a value it does not know reads as on", () => {
  expect(createLineAuthorsPref(() => memory("maybe")).get()).toBe(true);
});

it("failing storage gives the default and does not throw", () => {
  const broken: PrefStorage = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("full");
    },
  };
  const pref = createLineAuthorsPref(() => broken);
  expect(pref.get()).toBe(true);
  expect(() => pref.set(false)).not.toThrow();
  expect(pref.get()).toBe(false);
});

it("set tells each subscriber once, until it unsubscribes", () => {
  const pref = createLineAuthorsPref(() => memory());
  let calls = 0;
  const off = pref.subscribe(() => calls++);
  pref.set(false);
  expect(calls).toBe(1);
  off();
  pref.set(true);
  expect(calls).toBe(1);
});
