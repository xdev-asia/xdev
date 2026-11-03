import { describe, expect, it } from "vitest";
import { ignoreWhitespaceDiff, onlyWhitespace } from "./whitespace";

const spans = (a: string, b: string) => ignoreWhitespaceDiff(a, b).map((c) => [a.slice(c.fromA, c.toA), b.slice(c.fromB, c.toB)]);

describe("ignoreWhitespaceDiff", () => {
  it("ignores indent and trailing spaces", () => {
    expect(ignoreWhitespaceDiff("a\n  b\nc\n", "a\nb  \nc\n")).toEqual([]);
    expect(ignoreWhitespaceDiff("a  b\n", "a b\n")).toEqual([]);
    expect(ignoreWhitespaceDiff("a\tb\n", "a    b\n")).toEqual([]);
  });

  it("keeps a real change and maps offsets to the original text", () => {
    expect(spans("a\n  b\nc\n", "a\nb\nX\n")).toEqual([["c\n", "X\n"]]);
    expect(spans("one\ntwo\nthree\n", "one\n  two\nTHREE\nfour\n")).toEqual([["three\n", "THREE\nfour\n"]]);
  });

  it("handles inserts and deletes", () => {
    expect(spans("a\nc\n", "a\nb\nc\n")).toEqual([["", "b\n"]]);
    expect(spans("a\nb\nc\n", "a\nc\n")).toEqual([["b\n", ""]]);
    expect(spans("", "a\n")).toEqual([["", "a\n"]]);
    expect(spans("a\n", "")).toEqual([["a\n", ""]]);
  });

  it("finds several separate changes", () => {
    expect(spans("a\nb\nc\nd\ne\n", "A\nb\nc\nD\ne\n")).toEqual([
      ["a\n", "A\n"],
      ["d\n", "D\n"],
    ]);
  });

  it("copes with a missing final newline", () => {
    expect(spans("a\nb", "a\nB")).toEqual([["b", "B"]]);
    expect(ignoreWhitespaceDiff("a\nb", "a\nb\n")).toEqual([]);
  });
});

describe("onlyWhitespace", () => {
  it("is true only when the texts differ by whitespace", () => {
    expect(onlyWhitespace("a\n  b\n", "a\nb\n")).toBe(true);
    expect(onlyWhitespace("a\nb\n", "a\nb\n")).toBe(false);
    expect(onlyWhitespace("a\nb\n", "a\nc\n")).toBe(false);
  });
});
