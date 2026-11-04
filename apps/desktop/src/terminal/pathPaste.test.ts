import { describe, expect, it } from "vitest";
import { bracketed, dropPayloads, isImagePath, quotePath, shellKindFor, type ShellKind } from "./pathPaste";

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

describe("shellKindFor", () => {
  const cases: [string, boolean, boolean, ShellKind][] = [
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", false, true, "powershell"],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", false, true, "powershell"],
    ["C:\\Windows\\System32\\cmd.exe", false, true, "cmd"],
    ["C:\\Program Files\\Git\\bin\\bash.exe", false, true, "posix"],
    ["C:\\Windows\\System32\\wsl.exe", false, true, "posix"],
    ["/bin/zsh", false, false, "posix"],
    ["/usr/bin/fish", false, false, "fish"],
    ["/usr/local/bin/nu", false, false, "unknown"],
    ["", false, false, "unknown"],
    ["/usr/bin/claude", true, false, "posix"],
    ["C:\\tools\\claude.exe", true, true, "cmd"],
  ];
  it.each(cases)("%s (agent %s, windows %s) is %s", (program, agent, win, kind) => {
    expect(shellKindFor(program, agent, win)).toBe(kind);
  });
});

// [path, expected] per kind; null means the drop is refused.
const TABLE: Record<ShellKind, [string, string | null][]> = {
  posix: [
    ["/home/me/a_b-c.txt", "/home/me/a_b-c.txt"],
    ["/my dir/a.txt", "/my\\ dir/a.txt"],
    ["/it's/a.txt", "/it\\'s/a.txt"],
    ["/a/$HOME", "/a/\\$HOME"],
    ["/a/`id`", "/a/\\`id\\`"],
    ["/a/x;y&z|w", "/a/x\\;y\\&z\\|w"],
    ["/a/é ü", "/a/é\\ ü"],
    ["a\\b", "a\\\\b"],
    ["/a/b\nid", null],
    ["/a/b\rid", null],
  ],
  fish: [
    ["/my dir/a.txt", "/my\\ dir/a.txt"],
    ["a\\'\nid\n", null],
    ["a\\'", "a\\\\\\'"],
    ["/a/$x", "/a/\\$x"],
    ["/a/(id)", "/a/\\(id\\)"],
  ],
  powershell: [
    ["C:\\Users\\me\\a.txt", "C:\\Users\\me\\a.txt"],
    ["C:\\dl\\$(calc).txt", "'C:\\dl\\$(calc).txt'"],
    ["C:\\dl\\`x`.txt", "'C:\\dl\\`x`.txt'"],
    ["C:\\it's\\a.txt", "'C:\\it''s\\a.txt'"],
    ["C:\\it\u2019s\\a.txt", "'C:\\it\u2019\u2019s\\a.txt'"],
    ["C:\\a\u2018b\u201a\u201b", "'C:\\a\u2018\u2018b\u201a\u201a\u201b\u201b'"],
    ["C:\\My Files\\a;b&c|d.txt", "'C:\\My Files\\a;b&c|d.txt'"],
    ["@x", "'@x'"],
    ["C:\\é ü", "'C:\\é ü'"],
    ["C:\\a\nb", null],
  ],
  cmd: [
    ["C:\\Users\\me\\a.txt", "C:\\Users\\me\\a.txt"],
    ["C:\\My Files\\a.txt", '"C:\\My Files\\a.txt"'],
    ["C:\\a&b|c;d.txt", '"C:\\a&b|c;d.txt"'],
    ["C:\\100%\\a.txt", null],
    ["C:\\a!b", null],
    ["C:\\My Dir\\", '"C:\\My Dir\\\\"'],
    ["C:\\a\u00e9 b", '"C:\\a\u00e9 b"'],
    ["C:\\a\nb", null],
  ],
  unknown: [
    ["/home/me/a_b-c.txt", "/home/me/a_b-c.txt"],
    ["C:\\Users\\me\\a.txt", "C:\\Users\\me\\a.txt"],
    ["/my dir/a.txt", null],
    ["/a/$HOME", null],
    ["/a/b\nc", null],
  ],
};

describe("quotePath", () => {
  for (const [kind, rows] of Object.entries(TABLE) as [ShellKind, [string, string | null][]][]) {
    it.each(rows)(`${kind}: %j`, (path, expected) => {
      expect(quotePath(path, kind)).toBe(expected);
    });
  }

  it("refuses every control byte in every kind", () => {
    for (const kind of Object.keys(TABLE) as ShellKind[]) {
      for (const c of ["\x00", "\x07", "\x1b", "\x7f", "\x85", "\u2028"]) expect(quotePath(`/a${c}b`, kind)).toBeNull();
    }
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
    expect(dropPayloads(["/a/b.txt", "/my dir/c.txt"], "posix")).toEqual({ payloads: ["/a/b.txt ", "/my\\ dir/c.txt "], rejected: 0 });
    expect(dropPayloads(["C:\\My Files\\c.txt"], "cmd").payloads).toEqual(['"C:\\My Files\\c.txt" ']);
    expect(dropPayloads(["C:\\a\\$(calc).txt"], "powershell").payloads).toEqual(["'C:\\a\\$(calc).txt' "]);
  });

  it("pastes an image path as a bracketed paste of the quoted word", () => {
    expect(dropPayloads(["/a/shot.png"], "posix").payloads).toEqual([`${OPEN}/a/shot.png${CLOSE} `]);
    expect(dropPayloads(["C:\\a\\shot.PNG"], "cmd").payloads).toEqual([`${OPEN}C:\\a\\shot.PNG${CLOSE} `]);
    expect(dropPayloads(["/my dir/it's $x.png"], "posix").payloads).toEqual([`${OPEN}/my\\ dir/it\\'s\\ \\$x.png${CLOSE} `]);
    expect(dropPayloads(["C:\\My Files\\a.png"], "powershell").payloads).toEqual([`${OPEN}'C:\\My Files\\a.png'${CLOSE} `]);
  });

  it("with bracketed paste off an image is a plain quoted word like any other path", () => {
    expect(dropPayloads(["/a/shot.png", "/my dir/b.png"], "posix", false).payloads).toEqual(["/a/shot.png ", "/my\\ dir/b.png "]);
    expect(dropPayloads(["C:\\a\\shot.png"], "cmd", false).payloads).toEqual(["C:\\a\\shot.png "]);
  });

  it("refuses a path with a control byte, image or not, and counts it", () => {
    expect(dropPayloads(["/a/b\x07.png", "/a/c\nid", "/ok"], "posix")).toEqual({ payloads: ["/ok "], rejected: 2 });
    expect(dropPayloads(["/a b"], "unknown")).toEqual({ payloads: [], rejected: 1 });
  });

  it("an image dir name does not make a file an image", () => {
    expect(dropPayloads(["/a/dir.png/file"], "posix").payloads).toEqual(["/a/dir.png/file "]);
  });

  it("no space between two plain images, one after every other path", () => {
    expect(dropPayloads(["/a.png", "/b.jpg", "/c.png"], "posix").payloads).toEqual([
      `${OPEN}/a.png${CLOSE}`,
      `${OPEN}/b.jpg${CLOSE}`,
      `${OPEN}/c.png${CLOSE} `,
    ]);
    expect(dropPayloads(["/a.png", "/b.txt"], "posix").payloads).toEqual([`${OPEN}/a.png${CLOSE} `, "/b.txt "]);
    expect(dropPayloads(["/a b.png", "/c.png"], "posix").payloads[0].endsWith(`${CLOSE} `)).toBe(true);
  });

  it("an empty drop writes nothing", () => {
    expect(dropPayloads([], "posix")).toEqual({ payloads: [], rejected: 0 });
  });
});
