import { expect, it } from "vitest";
import { applyEvent, hitColumn, IDLE, lineStart, splitGlobs, STARTED, unitRanges } from "./searchState";

const file = (rel: string, n: number) => ({ rel, more: false, hits: Array.from({ length: n }, (_, i) => ({ line: i + 1, text: "x", ranges: [[0, 1]] as [number, number][] })) });

it("batches append and done and error end the search", () => {
  let r = applyEvent(STARTED, { type: "batch", files: [file("a", 2)] });
  r = applyEvent(r, { type: "batch", files: [file("b", 1)] });
  expect(r.files.map((f) => f.rel)).toEqual(["a", "b"]);
  expect(r.hits).toBe(3);
  expect(applyEvent(r, { type: "done", files: 2, hits: 3, truncated: true, ms: 4 })).toMatchObject({ phase: "done", truncated: true, hits: 3 });
  expect(applyEvent(IDLE, { type: "error", message: "bad regex" })).toMatchObject({ phase: "error", message: "bad regex" });
});

it("globs split on commas outside braces", () => {
  expect(splitGlobs("src/**/*.ts, *.md")).toEqual(["src/**/*.ts", "*.md"]);
  expect(splitGlobs("*.{ts,tsx},docs")).toEqual(["*.{ts,tsx}", "docs"]);
  expect(splitGlobs("  ")).toEqual([]);
});

it("ranges count code points, so an emoji before the match shifts by two UTF-16 units", () => {
  const text = "😀 foo";
  expect(unitRanges(text, [[2, 5]])).toEqual([[3, 6]]);
  expect(text.slice(3, 6)).toBe("foo");
  expect(unitRanges("tiếng việt", [[5, 9]])).toEqual([[5, 9]]);
});

it("the column is the first range, unless the line was clipped", () => {
  expect(hitColumn("abc foo", [[4, 7]])).toBe(5);
  expect(hitColumn("x".repeat(400), [[10, 11]])).toBeUndefined();
  expect(hitColumn("abc", [])).toBeUndefined();
});

it("a hit line drops its indent and starts near the first hit", () => {
  expect(lineStart("        private ILogger x;", 16)).toBe(8);
  expect(lineStart("    no hit", undefined)).toBe(4);
  const long = `    <member name="P:${"A".repeat(60)}ILogger">`;
  expect(lineStart(long, long.indexOf("ILogger"))).toBe(long.indexOf("ILogger") - 16);
  expect(lineStart("  x", 0)).toBe(0);
});
