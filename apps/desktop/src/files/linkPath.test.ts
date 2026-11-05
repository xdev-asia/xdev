import { describe, expect, it } from "vitest";
import { isAbsolutePath, pathToLine, relUnder, toNative } from "./linkPath";

describe("relUnder", () => {
  it("reads posix paths", () => {
    expect(relUnder("/home/u/wt", "/home/u/wt/src/a.ts", false)).toBe("src/a.ts");
    expect(relUnder("/home/u/wt/", "/home/u/wt/src/a.ts", false)).toBe("src/a.ts");
    expect(relUnder("/home/u/wt", "/home/u/wt/src/../b.ts", false)).toBe("b.ts");
    expect(relUnder("/home/u/wt", "/home/u/wt//src/./a.ts", false)).toBe("src/a.ts");
  });

  it("is null outside, at the root itself, and for a sibling that shares the prefix", () => {
    expect(relUnder("/home/u/wt", "/home/u/other/a.ts", false)).toBeNull();
    expect(relUnder("/home/u/wt", "/home/u/wt", false)).toBeNull();
    expect(relUnder("/home/u/wt", "/home/u/wt2/a.ts", false)).toBeNull();
    expect(relUnder("/home/u/wt", "/home/u/wt/../x/a.ts", false)).toBeNull();
    expect(relUnder("/home/u/wt", "/../a.ts", false)).toBeNull();
    expect(relUnder("/home/u/wt", "src/a.ts", false)).toBeNull();
  });

  it("reads Windows drive paths with either separator", () => {
    expect(relUnder("E:/wt", "E:\\wt\\src\\a.ts", false)).toBe("src/a.ts");
    expect(relUnder("E:\\wt", "E:/wt/src/a.ts", false)).toBe("src/a.ts");
    expect(relUnder("E:/wt", "F:/wt/src/a.ts", false)).toBeNull();
    expect(relUnder("\\\\?\\E:\\wt", "E:/wt/a.ts", false)).toBe("a.ts");
    expect(relUnder("E:/wt", "\\\\server\\share\\wt\\a.ts", false)).toBeNull();
  });

  it("folds case on Windows and macOS and keeps the case of the path it returns", () => {
    expect(relUnder("/Users/u/WT", "/users/u/wt/Src/A.ts", true)).toBe("Src/A.ts");
    expect(relUnder("/Users/u/WT", "/users/u/wt/Src/A.ts", false)).toBeNull();
    expect(relUnder("E:/WT", "e:/wt/a.ts", true)).toBe("a.ts");
    // A drive letter has no case on Windows, even where names do.
    expect(relUnder("E:/wt", "e:/wt/a.ts", false)).toBe("a.ts");
  });
});

describe("path helpers", () => {
  it("tells absolute paths", () => {
    for (const p of ["/a", "C:\\a", "C:/a", "C:", "\\\\h\\s"]) expect(isAbsolutePath(p), p).toBe(true);
    for (const p of ["a", "./a", "C:a", "src/a.ts", ""]) expect(isAbsolutePath(p), p).toBe(false);
  });

  it("writes the separators of the OS", () => {
    expect(toNative("E:/a/b.ts", true)).toBe("E:\\a\\b.ts");
    expect(toNative("/a/b.ts", false)).toBe("/a/b.ts");
    expect(pathToLine("E:/a/wt", "src/b.ts", 12, true)).toBe("E:\\a\\wt\\src\\b.ts:12");
    expect(pathToLine("/home/u/wt/", "src/b.ts", 12, false)).toBe("/home/u/wt/src/b.ts:12");
  });
});
