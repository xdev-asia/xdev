import { expect, it } from "vitest";
import { minimalChange } from "./textDiff";

const apply = (prev: string, c: { from: number; to: number; insert: string }) => prev.slice(0, c.from) + c.insert + prev.slice(c.to);

it("equal texts give null", () => {
  expect(minimalChange("abc", "abc")).toBeNull();
  expect(minimalChange("", "")).toBeNull();
});

it("an insert in the middle", () => {
  expect(minimalChange("abcd", "abXcd")).toEqual({ from: 2, to: 2, insert: "X" });
});

it("a delete at the end", () => {
  expect(minimalChange("abcd", "ab")).toEqual({ from: 2, to: 4, insert: "" });
});

it("a replace of everything", () => {
  expect(minimalChange("abc", "xyz")).toEqual({ from: 0, to: 3, insert: "xyz" });
});

it("repeated characters give a one-character insert", () => {
  const c = minimalChange("aaa", "aaaa")!;
  expect(c.insert).toBe("a");
  expect(c.to - c.from).toBe(0);
  expect(apply("aaa", c)).toBe("aaaa");
});

it("the suffix does not overlap the prefix", () => {
  const c = minimalChange("abab", "ab")!;
  expect(apply("abab", c)).toBe("ab");
});

it("a surrogate pair is not split", () => {
  // U+1F600 and U+1F601 share the high surrogate.
  const prev = "a\u{1F600}b";
  const next = "a\u{1F601}b";
  const c = minimalChange(prev, next)!;
  expect(c).toEqual({ from: 1, to: 3, insert: "\u{1F601}" });
  expect(apply(prev, c)).toBe(next);
  // Same low surrogate, different high one: the suffix keeps the pair whole too.
  const p2 = "a\u{1F600}";
  const n2 = "a\u{1F700}";
  const c2 = minimalChange(p2, n2)!;
  expect(c2.from).toBe(1);
  expect(apply(p2, c2)).toBe(n2);
  for (const ch of [c, c2]) {
    const lone = (s: string) => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);
    expect(lone(ch.insert)).toBe(false);
  }
});
