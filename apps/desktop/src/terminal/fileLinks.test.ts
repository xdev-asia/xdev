import { describe, expect, it } from "vitest";
import { findFileLinks, formatLocation, parseLocation } from "./fileLinks";

const paths = (line: string) => findFileLinks(line).map((l) => l.path);

describe("findFileLinks", () => {
  it("reads path, line, column and the range", () => {
    const line = "error in src/a.ts:12:5 here";
    expect(findFileLinks(line)).toEqual([{ path: "src/a.ts", line: 12, column: 5, start: 9, end: 22 }]);
    expect(line.slice(9, 22)).toBe("src/a.ts:12:5");
    expect(findFileLinks("src/a.ts:7")).toEqual([{ path: "src/a.ts", line: 7, start: 0, end: 10 }]);
    expect(findFileLinks("src/a.ts")).toEqual([{ path: "src/a.ts", start: 0, end: 8 }]);
  });

  it("trims brackets, quotes and punctuation around a path", () => {
    expect(paths("(src/a.ts)")).toEqual(["src/a.ts"]);
    expect(paths('"src/a.ts",')).toEqual(["src/a.ts"]);
    expect(paths("see 'src/a.ts'; then")).toEqual(["src/a.ts"]);
    expect(paths("wrote src/a.ts.")).toEqual(["src/a.ts"]);
    expect(paths("src/a.ts:12:5: error")).toEqual(["src/a.ts"]);
    expect(findFileLinks("(src/a.ts:3)")[0]).toMatchObject({ start: 1, end: 11, line: 3 });
  });

  it("keeps balanced brackets inside a path", () => {
    expect(paths("app/(shop)/[id]/page.tsx")).toEqual(["app/(shop)/[id]/page.tsx"]);
    expect(paths("(app/(shop)/page.tsx)")).toEqual(["app/(shop)/page.tsx"]);
  });

  it("skips URLs and a path inside one", () => {
    expect(paths("https://h/a/b.ts")).toEqual([]);
    expect(paths("see(https://h/a/b.ts)")).toEqual([]);
    expect(paths("ftp://h/a/b.ts:3")).toEqual([]);
  });

  it("reads Windows drive paths and keeps the drive colon", () => {
    expect(findFileLinks(String.raw`C:\x\y.rs:3`)).toEqual([{ path: String.raw`C:\x\y.rs`, line: 3, start: 0, end: 11 }]);
    expect(paths("E:/wt/a.ts")).toEqual(["E:/wt/a.ts"]);
    expect(paths("C:")).toEqual([]);
    expect(paths("C:12")).toEqual([]);
  });

  it("reads relative, parent and home paths", () => {
    expect(paths("./a ../b/c.md ~/x/y /abs/p")).toEqual(["./a", "../b/c.md", "~/x/y", "/abs/p"]);
    expect(paths("~")).toEqual([]);
  });

  it("reads bare file names only when they look like files", () => {
    expect(paths("README main.rs 12345 v1.2 Makefile word a.b")).toEqual(["README", "main.rs", "v1.2", "Makefile", "a.b"]);
    expect(paths("x.")).toEqual([]);
    expect(paths("...")).toEqual([]);
    expect(paths("a")).toEqual([]);
    expect(paths(`${"a".repeat(99)}.t`)).toEqual([]);
    expect(paths(`${"a".repeat(98)}.t`)).toHaveLength(1);
  });

  it("refuses a line or column below 1", () => {
    expect(paths("a.ts:0")).toEqual([]);
    expect(paths("src/a.ts:3:0")).toEqual([]);
    expect(paths("src/a.ts:9007199254740993")).toEqual([]);
  });

  it("refuses a folder and a path that does not start like one", () => {
    expect(paths("src/")).toEqual([]);
    expect(paths(String.raw`C:\x\ `)).toEqual([]);
    expect(paths("a/b/")).toEqual([]);
    expect(paths("=src/a.ts")).toEqual([]);
    expect(paths("a$b/c.ts")).toEqual([]);
  });

  it("reads CJK names and file URIs", () => {
    expect(paths("./ドキュメント/ファイル.md:3")).toEqual(["./ドキュメント/ファイル.md"]);
    expect(paths("./文档/说明～1.md")).toEqual(["./文档/说明～1.md"]);
    expect(findFileLinks("file:///a/b.ts:4")).toEqual([{ path: "file:///a/b.ts", line: 4, start: 0, end: 16 }]);
  });

  it("finds several paths in one line", () => {
    expect(paths("diff a/src/x.ts b/src/y.ts")).toEqual(["a/src/x.ts", "b/src/y.ts"]);
  });

  it("stays fast on a very long line", () => {
    const inputs = [
      "src/a.ts ".repeat(1200),
      "a/".repeat(5000),
      "(".repeat(10000),
      `${"a".repeat(1000)}:`.repeat(10),
      "/..".repeat(3000),
      ":1".repeat(5000),
    ];
    const t0 = performance.now();
    for (const line of inputs) findFileLinks(line);
    expect(performance.now() - t0).toBeLessThan(2000);
    const one = performance.now();
    findFileLinks("x ".repeat(5000));
    expect(performance.now() - one).toBeLessThan(200);
  });
});

describe("parseLocation and formatLocation", () => {
  it("round trips", () => {
    expect(parseLocation("a/b.ts:3:4")).toEqual({ path: "a/b.ts", line: 3, column: 4 });
    expect(parseLocation("a/b.ts")).toEqual({ path: "a/b.ts" });
    expect(parseLocation("a/b.ts:0")).toBeNull();
    expect(formatLocation("a/b.ts", 3, 4)).toBe("a/b.ts:3:4");
    expect(formatLocation("a/b.ts", 3)).toBe("a/b.ts:3");
    expect(formatLocation("a/b.ts")).toBe("a/b.ts");
    expect(formatLocation("a/b.ts", undefined, 4)).toBe("a/b.ts");
  });
});
