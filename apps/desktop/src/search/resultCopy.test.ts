import { expect, it } from "vitest";
import { absolutePath, pathWithLine, relativePath } from "./resultCopy";

it("keeps a posix relative path", () => {
  expect(relativePath("src/a/b.ts")).toBe("src/a/b.ts");
  expect(relativePath("./src/b.ts")).toBe("src/b.ts");
});

it("turns Windows backslashes into forward slashes in the relative form", () => {
  expect(relativePath("src\\a\\b.ts")).toBe("src/a/b.ts");
  expect(pathWithLine("src\\a\\b.ts", 7)).toBe("src/a/b.ts#L7");
});

it("joins the worktree root and the relative path", () => {
  expect(absolutePath("/demo/wt/oak", "src/a.ts")).toBe("/demo/wt/oak/src/a.ts");
  expect(absolutePath("/demo/wt/oak/", "src/a.ts")).toBe("/demo/wt/oak/src/a.ts");
});

it("keeps backslashes in an absolute Windows path", () => {
  expect(absolutePath("C:\\work\\oak", "src\\a.ts")).toBe("C:\\work\\oak\\src\\a.ts");
  expect(absolutePath("C:\\work\\oak", "src/a.ts")).toBe("C:\\work\\oak\\src\\a.ts");
  expect(absolutePath("C:/work/oak", "src\\a.ts")).toBe("C:/work/oak/src/a.ts");
});

it("writes the 1-based line after #L", () => {
  expect(pathWithLine("src/a.ts", 42)).toBe("src/a.ts#L42");
});
