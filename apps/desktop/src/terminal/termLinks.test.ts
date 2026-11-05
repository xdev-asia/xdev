import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILink } from "@xterm/xterm";
import { translate } from "@/i18n";
import {
  createFileLinkProvider,
  createLinkResolver,
  createOscLinkHandler,
  cwdFromOsc7,
  logicalLine,
  parseOscTarget,
  urlLinkOptions,
  type BufferLike,
  type TermLinksEnv,
} from "./termLinks";
import type { LinkMenu } from "./linkMenu";

// A buffer of rows; a wide character takes two cells, the second one empty with width 0.
function bufferOf(rows: { text: string; wrapped?: boolean }[], cols = 40): BufferLike {
  const lines = rows.map(({ text, wrapped }) => {
    const cells: { chars: string; width: number }[] = [];
    for (const ch of text) {
      const wide = /[　-ヿ一-鿿]/.test(ch);
      cells.push({ chars: ch, width: wide ? 2 : 1 });
      if (wide) cells.push({ chars: "", width: 0 });
    }
    while (cells.length < cols) cells.push({ chars: "", width: 1 });
    return {
      isWrapped: wrapped === true,
      length: cols,
      getCell: (x: number) => (cells[x] ? { getChars: () => cells[x]!.chars, getWidth: () => cells[x]!.width } : undefined),
    };
  });
  return { length: lines.length, getLine: (y) => lines[y] };
}

const click = (more: Partial<MouseEvent> = {}) => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, clientX: 7, clientY: 9, ...more }) as MouseEvent;

function setup(rows: { text: string; wrapped?: boolean }[], files: string[] = ["src/a.ts"], more: Partial<TermLinksEnv> = {}) {
  const resolved: string[][] = [];
  const opened: unknown[] = [];
  const urls: string[] = [];
  const defaults: string[] = [];
  const tips: (string | null)[] = [];
  const menus: { at: { x: number; y: number }; menu: LinkMenu }[] = [];
  let buffer = bufferOf(rows);
  const env: TermLinksEnv = {
    worktree: () => "/wt",
    buffer: () => buffer,
    resolve: async (_wt, paths) => {
      resolved.push(paths);
      return paths.map((p) => (files.includes(p.replace(/^\.\//, "")) ? p.replace(/^\.\//, "") : null));
    },
    settings: () => ({ linkClick: "actions", urlMiddleClick: "open" }),
    mac: false,
    deps: {
      api: {
        fileOpenDefault: async (_w, rel) => void defaults.push(rel),
        fileReveal: async () => {},
        openUrl: async (url) => void urls.push(url),
      },
      openFile: (req) => void opened.push(req),
      copyText: async () => true,
      toast: () => {},
      t: (key, vars) => translate("en", key, vars),
      mac: false,
      onSettings: () => {},
      focusTerminal: () => {},
    },
    showMenu: (at, menu) => {
      menus.push({ at, menu });
      return true;
    },
    tip: (text) => void tips.push(text),
    ...more,
  };
  const links = (y: number) =>
    new Promise<ILink[] | undefined>((resolve) => createFileLinkProvider(env).provideLinks(y, resolve));
  return { env, links, resolved, opened, urls, defaults, tips, menus, setBuffer: (b: BufferLike) => (buffer = b) };
}

describe("file link provider", () => {
  it("makes a link only for a resolved file, with a 1-based inclusive range", async () => {
    const s = setup([{ text: "error in src/a.ts:12:5 and gone.ts" }]);
    const links = (await s.links(1))!;
    expect(links).toHaveLength(1);
    expect(links[0]!.text).toBe("src/a.ts:12:5");
    expect(links[0]!.range).toEqual({ start: { x: 10, y: 1 }, end: { x: 22, y: 1 } });
    // One call, each candidate once.
    expect(s.resolved).toEqual([["src/a.ts", "gone.ts"]]);
  });

  it("asks for nothing when a row has no candidates", async () => {
    const s = setup([{ text: "plain words here" }]);
    expect(await s.links(1)).toBeUndefined();
    expect(s.resolved).toEqual([]);
    expect(await setup([{ text: "src/a.ts" }], [], { worktree: () => undefined }).links(1)).toBeUndefined();
  });

  it("sends at most 64 candidates", async () => {
    const names = Array.from({ length: 100 }, (_, i) => `f${i}.ts`);
    const s = setup([], []);
    s.setBuffer(bufferOf([{ text: names.join(" ") }], 1000));
    await s.links(1);
    expect(s.resolved).toHaveLength(1);
    expect(s.resolved[0]).toEqual(names.slice(0, 64));
  });

  it("counts a wide character as two cells", async () => {
    const s = setup([{ text: "文 src/a.ts" }]);
    const [link] = (await s.links(1))!;
    expect(link!.range).toEqual({ start: { x: 4, y: 1 }, end: { x: 11, y: 1 } });
  });

  it("joins wrapped rows and gives the link to each row it covers", async () => {
    const rows = [{ text: "x ".repeat(18) + "src/" }, { text: "a.ts:3 tail", wrapped: true }];
    const s = setup(rows, ["src/a.ts"]);
    for (const y of [1, 2]) {
      const [link] = (await s.links(y))!;
      expect(link!.text).toBe("src/a.ts:3");
      expect(link!.range).toEqual({ start: { x: 37, y: 1 }, end: { x: 6, y: 2 } });
    }
  });

  it("does not give a row a link that lives on another logical line", async () => {
    const s = setup([{ text: "src/a.ts" }, { text: "nothing" }]);
    expect(await s.links(2)).toBeUndefined();
  });

  it("drops an answer for a row that changed meanwhile", async () => {
    const s = setup([{ text: "src/a.ts" }]);
    const env = { ...s.env, resolve: async (_w: string, p: string[]) => { s.setBuffer(bufferOf([{ text: "other" }])); return p.map(() => "src/a.ts"); } };
    const out = await new Promise<ILink[] | undefined>((r) => createFileLinkProvider(env).provideLinks(1, r));
    expect(out).toBeUndefined();
  });

  it("asks the backend with the shell's folder when it is known", async () => {
    const seen: (string | undefined)[] = [];
    let cwd: string | undefined;
    const s = setup([{ text: "src/a.ts" }], ["src/a.ts"], {
      cwd: () => cwd,
      resolve: async (_w, paths, dir) => {
        seen.push(dir);
        return paths;
      },
    });
    await s.links(1);
    cwd = "/wt/pkg";
    await s.links(1);
    expect(seen).toEqual([undefined, "/wt/pkg"]);
  });

  it("answers nothing when the backend fails", async () => {
    const s = setup([{ text: "src/a.ts" }], [], { resolve: () => Promise.reject({ code: "io" }) });
    expect(await s.links(1)).toBeUndefined();
  });

  it("routes a click by gesture", async () => {
    const s = setup([{ text: "src/a.ts:12:5" }]);
    const [link] = (await s.links(1))!;
    link!.activate(click(), link!.text);
    expect(s.menus).toHaveLength(1);
    expect(s.menus[0]!.at).toEqual({ x: 7, y: 9 });
    expect(s.menus[0]!.menu.title).toBe("src/a.ts:12:5");
    expect(s.opened).toEqual([]);
    link!.activate(click({ ctrlKey: true }), link!.text);
    expect(s.opened).toEqual([{ worktree: "/wt", rel: "src/a.ts", line: 12, column: 5 }]);
    link!.activate(click({ ctrlKey: true, shiftKey: true }), link!.text);
    await Promise.resolve();
    expect(s.defaults).toEqual(["src/a.ts"]);
    link!.activate(click({ altKey: true, ctrlKey: true }), link!.text);
    link!.activate(click({ button: 1 }), link!.text);
    expect(s.opened).toHaveLength(1);
    expect(s.menus).toHaveLength(1);
  });

  it("opens straight away when there is no menu host, and follows the setting", async () => {
    const s = setup([{ text: "src/a.ts" }], ["src/a.ts"], { showMenu: undefined });
    const [link] = (await s.links(1))!;
    link!.activate(click(), link!.text);
    expect(s.opened).toEqual([{ worktree: "/wt", rel: "src/a.ts" }]);
    const none = setup([{ text: "src/a.ts" }], ["src/a.ts"], { settings: () => ({ linkClick: "none", urlMiddleClick: "open" }) });
    const [quiet] = (await none.links(1))!;
    quiet!.activate(click(), quiet!.text);
    expect(none.opened).toEqual([]);
    expect(none.menus).toEqual([]);
  });

  it("shows the tip on hover and hides it on leave", async () => {
    const s = setup([{ text: "src/a.ts:3" }]);
    const [link] = (await s.links(1))!;
    link!.hover!(click(), link!.text);
    link!.leave!(click(), link!.text);
    expect(s.tips).toEqual(["src/a.ts:3 (Click for actions, Ctrl+click to open, or Shift+Ctrl+click for default app)", null]);
  });
});

describe("logicalLine", () => {
  it("stops at a row that is not wrapped and reaches back to the first row", () => {
    const b = bufferOf([{ text: "aaa" }, { text: "bbb" }, { text: "ccc", wrapped: true }], 3);
    expect(logicalLine(b, 0)!.text).toBe("aaa");
    expect(logicalLine(b, 2)!.text).toBe("bbbccc");
    expect(logicalLine(b, 2)!.first).toBe(1);
    expect(logicalLine(b, 9)).toBeNull();
  });
});

describe("resolver cache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps an answer for 5 seconds, then asks again", async () => {
    const calls: string[][] = [];
    const resolve = createLinkResolver(async (_w, paths) => {
      calls.push(paths);
      return paths.map((p) => p);
    });
    expect(await resolve("/wt", ["a.ts", "b.ts"])).toEqual(["a.ts", "b.ts"]);
    expect(await resolve("/wt", ["a.ts"])).toEqual(["a.ts"]);
    expect(calls).toEqual([["a.ts", "b.ts"]]);
    vi.advanceTimersByTime(4999);
    await resolve("/wt", ["a.ts", "c.ts"]);
    expect(calls).toEqual([["a.ts", "b.ts"], ["c.ts"]]);
    vi.advanceTimersByTime(5001);
    await resolve("/wt", ["a.ts"]);
    expect(calls.at(-1)).toEqual(["a.ts"]);
  });

  it("passes the folder on and keeps an answer per folder", async () => {
    const calls: (string | undefined)[] = [];
    const resolve = createLinkResolver(async (_w, paths, cwd) => {
      calls.push(cwd);
      return paths.map((p) => `${cwd ?? ""}/${p}`);
    });
    expect(await resolve("/wt", ["a.ts"], "/wt/x")).toEqual(["/wt/x/a.ts"]);
    expect(await resolve("/wt", ["a.ts"], "/wt/y")).toEqual(["/wt/y/a.ts"]);
    expect(await resolve("/wt", ["a.ts"])).toEqual(["/a.ts"]);
    expect(await resolve("/wt", ["a.ts"], "/wt/x")).toEqual(["/wt/x/a.ts"]);
    expect(calls).toEqual(["/wt/x", "/wt/y", undefined]);
  });

  it("keeps a null answer, shares a pending call, and forgets a failure", async () => {
    let n = 0;
    const resolve = createLinkResolver(async (_w, paths) => {
      n++;
      return paths.map(() => null);
    });
    await Promise.all([resolve("/wt", ["x"]), resolve("/wt", ["x"])]);
    await resolve("/wt", ["x"]);
    expect(n).toBe(1);

    let fails = 0;
    const flaky = createLinkResolver(async () => {
      fails++;
      throw { code: "io" };
    });
    expect(await flaky("/wt", ["y"])).toEqual([null]);
    expect(await flaky("/wt", ["y"])).toEqual([null]);
    expect(fails).toBe(2);
  });

  it("keeps worktrees apart and splits more than 64 into calls of 64", async () => {
    const sizes: number[] = [];
    const resolve = createLinkResolver(async (_w, paths) => {
      sizes.push(paths.length);
      return paths.map((p) => p);
    });
    await resolve("/a", ["x"]);
    await resolve("/b", ["x"]);
    expect(sizes).toEqual([1, 1]);
    await resolve("/c", Array.from({ length: 130 }, (_, i) => `f${i}`));
    expect(sizes.slice(2)).toEqual([64, 64, 2]);
  });
});

describe("url handler", () => {
  it("routes a click by gesture and shows the tip", () => {
    const s = setup([]);
    const url = urlLinkOptions(s.env);
    url.handler(click(), "https://x.dev/a");
    expect(s.menus[0]!.menu.title).toBe("https://x.dev/a");
    url.handler(click({ ctrlKey: true }), "https://x.dev/a");
    url.handler(click({ button: 1 }), "https://x.dev/b");
    url.handler(click({ button: 2 }), "https://x.dev/c");
    expect(s.urls).toEqual(["https://x.dev/a", "https://x.dev/b"]);
    url.hover(click(), "https://x.dev/a");
    url.leave();
    expect(s.tips).toEqual(["https://x.dev/a (Click for actions, Ctrl+click to open)", null]);
  });

  it("a middle click can show the menu or do nothing", () => {
    const menu = setup([], [], { settings: () => ({ linkClick: "open", urlMiddleClick: "actions" }) });
    urlLinkOptions(menu.env).handler(click({ button: 1 }), "https://x.dev");
    expect(menu.menus).toHaveLength(1);
    const none = setup([], [], { settings: () => ({ linkClick: "open", urlMiddleClick: "none" }) });
    urlLinkOptions(none.env).handler(click({ button: 1 }), "https://x.dev");
    expect(none.urls).toEqual([]);
  });
});

describe("OSC 8", () => {
  it("parses targets", () => {
    expect(parseOscTarget("https://x.dev/a")).toEqual({ kind: "url", url: "https://x.dev/a" });
    expect(parseOscTarget("HTTP://x.dev")).toEqual({ kind: "url", url: "HTTP://x.dev" });
    expect(parseOscTarget("file:///wt/src/a.ts")).toEqual({ kind: "file", path: "file:///wt/src/a.ts" });
    expect(parseOscTarget("file://localhost/wt/a.ts:12:5")).toEqual({ kind: "file", path: "file://localhost/wt/a.ts", line: 12, column: 5 });
    expect(parseOscTarget("file:///wt/a.ts#L12C3")).toEqual({ kind: "file", path: "file:///wt/a.ts" });
    expect(parseOscTarget("src/a.ts:12")).toEqual({ kind: "file", path: "src/a.ts", line: 12 });
    expect(parseOscTarget("a.ts:12")).toEqual({ kind: "file", path: "a.ts", line: 12 });
    expect(parseOscTarget("E:\\wt\\a.ts:3")).toEqual({ kind: "file", path: "E:\\wt\\a.ts", line: 3 });
    for (const no of ["mailto:a@b.c", "ssh://h/x", "file://host/x", "javascript:alert(1)", "ftp://h/a", "file:relative", "src/a.ts:0", ""]) {
      expect(parseOscTarget(no), no).toBeNull();
    }
  });

  it("routes http, file and other targets", async () => {
    const s = setup([]);
    const h = createOscLinkHandler(s.env);
    expect(h.allowNonHttpProtocols).toBe(true);
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
    h.activate(click({ ctrlKey: true }), "https://x.dev", range);
    h.activate(click({ ctrlKey: true }), "mailto:a@b.c", range);
    h.activate(click({ ctrlKey: true, button: 1 }), "https://x.dev/mid", range);
    expect(s.urls).toEqual(["https://x.dev"]);
    h.activate(click({ ctrlKey: true }), "src/a.ts:4:2", range);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.opened).toEqual([{ worktree: "/wt", rel: "src/a.ts", line: 4, column: 2 }]);
    h.activate(click(), "src/a.ts:4", range);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.menus.at(-1)!.menu.title).toBe("src/a.ts:4");
    h.activate(click({ ctrlKey: true }), "missing.ts", range);
    await new Promise((r) => setTimeout(r, 0));
    expect(s.opened).toHaveLength(1);
  });

  it("shows the raw target in the tip", () => {
    const s = setup([]);
    const h = createOscLinkHandler(s.env);
    const range = { start: { x: 1, y: 1 }, end: { x: 2, y: 1 } };
    h.hover!(click(), "https://x.dev", range);
    h.hover!(click(), "mailto:a@b.c", range);
    h.leave!(click(), "https://x.dev", range);
    expect(s.tips).toEqual(["https://x.dev (Click for actions, Ctrl+click to open)", null]);
  });
});

describe("cwdFromOsc7", () => {
  it("reads the folder a shell reports", () => {
    expect(cwdFromOsc7("file://host/home/me/wt/pkg")).toBe("/home/me/wt/pkg");
    expect(cwdFromOsc7("file:///home/me/my%20wt")).toBe("/home/me/my wt");
    expect(cwdFromOsc7("FILE://localhost/tmp/x")).toBe("/tmp/x");
    expect(cwdFromOsc7("file:///C:/Users/me/wt")).toBe("C:/Users/me/wt");
  });

  it("refuses anything else", () => {
    for (const bad of ["", "/home/me", "http://h/x", "file://host", "file:///a/%ZZ", "file:///a%00b", `file:///${"a".repeat(4097)}`]) {
      expect(cwdFromOsc7(bad), bad.slice(0, 20)).toBeUndefined();
    }
  });
});
