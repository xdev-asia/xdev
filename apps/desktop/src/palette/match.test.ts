import { expect, it } from "vitest";
import { matchField, matchItem, mergeRanges, tokens } from "./match";

it("tokens splits, lowercases, dedupes and caps at 8", () => {
  expect(tokens("  Foo bar  FOO ")).toEqual(["foo", "bar"]);
  expect(tokens("")).toEqual([]);
  expect(tokens("a b c d e f g h i j")).toHaveLength(8);
});

it("exact beats prefix beats word prefix beats substring beats subsequence", () => {
  const exact = matchField("main", "main")!.score;
  const prefix = matchField("mai", "main-fix")!.score;
  const word = matchField("fix", "main-fix")!.score;
  const sub = matchField("ain", "main")!.score;
  const seq = matchField("mnx", "main-fix")!.score;
  expect(exact).toBeGreaterThan(prefix);
  expect(prefix).toBeGreaterThan(word);
  expect(word).toBeGreaterThan(sub);
  expect(sub).toBeGreaterThan(seq);
  expect(seq).toBeGreaterThan(0);
  expect(matchField("zz", "main")).toBeNull();
});

it("word starts include camelCase, dash, slash and dot", () => {
  expect(matchField("tree", "workTree")!.hits).toEqual([[4, 8]]);
  expect(matchField("fix", "feat/fix")!.score).toBe(matchField("fix", "feat-fix")!.score);
  expect(matchField("ts", "app.ts")!.score).toBe(matchField("ts", "app ts")!.score);
  expect(matchField("tree", "workTree")!.score).toBeGreaterThan(matchField("ree", "workTree")!.score);
});

it("single letter matches word starts only", () => {
  expect(matchField("a", "agents")).not.toBeNull();
  expect(matchField("a", "new agent")!.hits).toEqual([[4, 5]]);
  expect(matchField("a", "main")).toBeNull();
});

it("subsequence scores fewer gaps higher", () => {
  const tight = matchField("abc", "xabxc")!;
  const loose = matchField("abc", "xaxxxxbxxxxxc")!;
  expect(tight.score).toBeGreaterThan(loose.score);
  expect(tight.hits).toEqual([[1, 3], [4, 5]]);
});

it("every token must match some field", () => {
  const item = { title: "Settings", detail: "repos" };
  expect(matchItem(item, ["set", "rep"])).not.toBeNull();
  expect(matchItem(item, ["set", "zzz"])).toBeNull();
});

it("title weighs more than detail and keywords", () => {
  const inTitle = matchItem({ title: "main", detail: "x" }, ["main"])!.score;
  const inDetail = matchItem({ title: "x", detail: "main" }, ["main"])!.score;
  const inKeyword = matchItem({ title: "x", keywords: ["main"] }, ["main"])!.score;
  expect(inTitle).toBeGreaterThan(inDetail);
  expect(inDetail).toBeGreaterThan(inKeyword);
});

it("hits are merged ranges in title and detail", () => {
  const m = matchItem({ title: "feature", detail: "xdev / feature" }, ["feat", "ure"])!;
  expect(m.hits.title).toEqual([[0, 7]]);
  expect(mergeRanges([[3, 5], [0, 2], [2, 3], [7, 8]])).toEqual([[0, 5], [7, 8]]);
});

it("keyword-only match has no visible hits", () => {
  const m = matchItem({ title: "New worktree", keywords: ["create"] }, ["create"])!;
  expect(m.hits).toEqual({ title: [], detail: [] });
});

it("folds Vietnamese marks in the query and the field", () => {
  expect(matchField("cai", "Cài đặt")?.hits).toEqual([[0, 3]]);
  expect(matchField("dat", "Cài đặt")?.hits).toEqual([[4, 7]]);
  expect(matchField("đặt", "Cai dat")).not.toBeNull();
  expect(tokens("Cài Đặt")).toEqual(["cai", "dat"]);
  const m = matchItem({ title: "Cài đặt" }, tokens("cai dat"));
  expect(m?.hits.title).toEqual([[0, 3], [4, 7]]);
});

it("folding keeps hit offsets aligned with the original text", () => {
  expect(matchField("b", "Tiếng Việt b")?.hits).toEqual([[11, 12]]);
});
