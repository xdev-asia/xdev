import { describe, expect, it } from "vitest";
import { bracketed, dropPayloads, isImagePath, shellQuotePath } from "./pathPaste";

const OPEN = "\x1b[200~";
const CLOSE = "\x1b[201~";

describe("isImagePath", () => {
  it("goes by the extension of the last segment, any case", () => {
    expect(isImagePath("/a/shot.png")).toBe(true);
    expect(isImagePath("/a/SHOT.PNG")).toBe(true);
    expect(isImagePath("C:\\pics\\a.JPeG")).toBe(true);
    expect(isImagePath("/a/b.webp")).toBe(true);
    expect(isImagePath("/a/notes.txt")).toBe(false);
    expect(isImagePath("/a/noext")).toBe(false);
  });
  it("ignores an image-like directory name", () => {
    expect(isImagePath("/a/dir.png/file")).toBe(false);
    expect(isImagePath("C:\\a\\dir.png\\file.txt")).toBe(false);
  });
});

describe("shellQuotePath", () => {
  it("leaves a plain path bare", () => {
    expect(shellQuotePath("/home/me/a_b-c.txt", "posix")).toBe("/home/me/a_b-c.txt");
    expect(shellQuotePath("C:\\Users\\me\\a.txt", "windows")).toBe("C:\\Users\\me\\a.txt");
  });
  it("single-quotes on posix and escapes an embedded quote", () => {
    expect(shellQuotePath("/my dir/a.txt", "posix")).toBe("'/my dir/a.txt'");
    expect(shellQuotePath("/it's/a.txt", "posix")).toBe("'/it'\\''s/a.txt'");
    expect(shellQuotePath("/a/$HOME", "posix")).toBe("'/a/$HOME'");
  });
  it("double-quotes on windows", () => {
    expect(shellQuotePath("C:\\My Files\\a.txt", "windows")).toBe('"C:\\My Files\\a.txt"');
    expect(shellQuotePath("C:\\a\\$x", "windows")).toBe('"C:\\a\\$x"');
  });
});

describe("bracketed", () => {
  it("wraps the text and strips ESC and controls but keeps a tab", () => {
    expect(bracketed("a\tb")).toBe(`${OPEN}a\tb${CLOSE}`);
    expect(bracketed("a\x1b[201~b\x07\r\n")).toBe(`${OPEN}a[201~b${CLOSE}`);
  });
});

describe("dropPayloads", () => {
  it("quotes a non-image path and adds a space", () => {
    expect(dropPayloads(["/a/b.txt", "/my dir/c.txt"], "posix")).toEqual(["/a/b.txt ", "'/my dir/c.txt' "]);
    expect(dropPayloads(["C:\\My Files\\c.txt"], "windows")).toEqual(['"C:\\My Files\\c.txt" ']);
  });

  it("pastes a plain image path as a bracketed paste", () => {
    expect(dropPayloads(["/a/shot.png"], "posix")).toEqual([`${OPEN}/a/shot.png${CLOSE} `]);
    expect(dropPayloads(["C:\\a\\shot.PNG"], "windows")).toEqual([`${OPEN}C:\\a\\shot.PNG${CLOSE} `]);
  });

  it("escapes a posix image path and quotes a windows one", () => {
    expect(dropPayloads(["/my dir/it's $x.png"], "posix")).toEqual([`${OPEN}/my\\ dir/it\\'s\\ \\$x.png${CLOSE} `]);
    expect(dropPayloads(["/a/é ü.png"], "posix")).toEqual([`${OPEN}/a/é\\ ü.png${CLOSE} `]);
    expect(dropPayloads(["C:\\My Files\\a.png"], "windows")).toEqual([`${OPEN}"C:\\My Files\\a.png"${CLOSE} `]);
    expect(dropPayloads(["C:\\a\\100%.png"], "windows")).toEqual([`${OPEN}"C:\\a\\100%.png"${CLOSE} `]);
  });

  it("a backslash is plain on windows but special on posix", () => {
    expect(dropPayloads(["C:\\a\\b.png"], "windows")).toEqual([`${OPEN}C:\\a\\b.png${CLOSE} `]);
    expect(dropPayloads(["a\\b.png"], "posix")).toEqual([`${OPEN}a\\\\b.png${CLOSE} `]);
  });

  it("a control byte makes an image a quoted path, not a bracketed paste", () => {
    expect(dropPayloads(["/a/b\x07.png"], "posix")).toEqual(["'/a/b\x07.png' "]);
  });

  it("an image dir name does not make a file an image", () => {
    expect(dropPayloads(["/a/dir.png/file"], "posix")).toEqual(["/a/dir.png/file "]);
  });

  it("no space between two plain images, one after every other path", () => {
    expect(dropPayloads(["/a.png", "/b.jpg", "/c.png"], "posix")).toEqual([
      `${OPEN}/a.png${CLOSE}`,
      `${OPEN}/b.jpg${CLOSE}`,
      `${OPEN}/c.png${CLOSE} `,
    ]);
    expect(dropPayloads(["/a.png", "/b.txt"], "posix")).toEqual([`${OPEN}/a.png${CLOSE} `, "/b.txt "]);
    expect(dropPayloads(["/a b.png", "/c.png"], "posix")[0].endsWith(`${CLOSE} `)).toBe(true);
  });

  it("an empty drop writes nothing", () => {
    expect(dropPayloads([], "posix")).toEqual([]);
  });
});
