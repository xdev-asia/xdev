import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PtyClient } from "./ptyClient";
import { CONTEXT_LINES, copyContext, copyText, createTerminalHandle, terminalContext, type XTermLike } from "./terminalActions";

// A stand-in xterm: a buffer of lines and spies for every call the handle makes.
function fakeTerm(over: Partial<XTermLike> = {}, buffer: string[] = []) {
  let selection = "";
  const term = {
    cols: 80,
    rows: 24,
    getSelection: vi.fn(() => selection),
    hasSelection: vi.fn(() => selection.length > 0),
    paste: vi.fn(),
    modes: { bracketedPasteMode: true },
    selectAll: vi.fn(),
    clear: vi.fn(),
    reset: vi.fn(),
    focus: vi.fn(),
    buffer: { active: { length: buffer.length, getLine: (y: number) => (y < buffer.length ? { translateToString: () => buffer[y] } : undefined) } },
    ...over,
  };
  return { term, select: (text: string) => void (selection = text) };
}

function fakeClient() {
  return { input: vi.fn(async () => {}), resize: vi.fn(async () => {}) };
}

function handleFor(term: XTermLike | null, client = fakeClient(), find = vi.fn()) {
  const h = createTerminalHandle({ term: () => term, client: () => client as unknown as PtyClient, find });
  return { h, client, find };
}

let writeText: ReturnType<typeof vi.fn>;
let readText: ReturnType<typeof vi.fn>;
beforeEach(() => {
  writeText = vi.fn(async () => {});
  readText = vi.fn(async () => "pasted text");
  vi.stubGlobal("navigator", { clipboard: { writeText, readText } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it("copy returns false and writes nothing when nothing is selected", async () => {
  const { term } = fakeTerm();
  const { h } = handleFor(term);
  expect(h.hasSelection()).toBe(false);
  expect(await h.copy()).toBe(false);
  expect(writeText).not.toHaveBeenCalled();
});

it("copy writes the selection to the clipboard", async () => {
  const { term, select } = fakeTerm();
  select("ls -la");
  const { h } = handleFor(term);
  expect(h.hasSelection()).toBe(true);
  expect(await h.copy()).toBe(true);
  expect(writeText).toHaveBeenCalledWith("ls -la");
});

it("copy returns false when the webview refuses the clipboard", async () => {
  const { term, select } = fakeTerm();
  select("x");
  writeText.mockRejectedValueOnce(new Error("denied"));
  const { h } = handleFor(term);
  expect(await h.copy()).toBe(false);
});

it("paste hands the clipboard text to term.paste, not straight to the pty", async () => {
  const { term } = fakeTerm();
  const { h, client } = handleFor(term);
  await h.paste();
  expect(term.paste).toHaveBeenCalledWith("pasted text");
  expect(client.input).not.toHaveBeenCalled();
});

it("paste of an empty or refused clipboard does nothing", async () => {
  const { term } = fakeTerm();
  const { h } = handleFor(term);
  readText.mockResolvedValueOnce("");
  await h.paste();
  readText.mockRejectedValueOnce(new Error("denied"));
  await h.paste();
  expect(term.paste).not.toHaveBeenCalled();
});

it("paste with no text saves the clipboard image and writes its path as a bracketed paste", async () => {
  const { term } = fakeTerm();
  const client = fakeClient();
  const pasted = vi.fn();
  const h = createTerminalHandle({
    term: () => term,
    client: () => client as unknown as PtyClient,
    find: vi.fn(),
    saveImage: async () => "/tmp/a.png",
    pasted,
  });
  readText.mockResolvedValueOnce("");
  await h.paste();
  expect(client.input).toHaveBeenCalledWith("[200~/tmp/a.png[201~");
  expect(term.paste).not.toHaveBeenCalled();
  expect(pasted).toHaveBeenCalledWith("image");
});

it("paste reports a failed image save", async () => {
  const { term } = fakeTerm();
  const pasted = vi.fn();
  const h = createTerminalHandle({
    term: () => term,
    client: () => fakeClient() as unknown as PtyClient,
    find: vi.fn(),
    saveImage: async () => Promise.reject({ code: "too_large" }),
    pasted,
  });
  readText.mockResolvedValueOnce("");
  await h.paste();
  expect(pasted).toHaveBeenCalledWith("too_large");
});

it("clear, select all and focus act on the xterm and write nothing to the pty (R4)", () => {
  const { term } = fakeTerm();
  const { h, client } = handleFor(term);
  h.clear();
  h.selectAll();
  h.focus();
  expect(term.clear).toHaveBeenCalledTimes(1);
  expect(term.selectAll).toHaveBeenCalledTimes(1);
  expect(term.focus).toHaveBeenCalledTimes(1);
  expect(client.input).not.toHaveBeenCalled();
});

it("reset calls term.reset and writes nothing to the pty", () => {
  const { term } = fakeTerm();
  const { h, client } = handleFor(term);
  h.reset();
  expect(term.reset).toHaveBeenCalledTimes(1);
  expect(client.input).not.toHaveBeenCalled();
});

it("find opens the find bar", () => {
  const { term } = fakeTerm();
  const { h, find } = handleFor(term);
  h.find();
  expect(find).toHaveBeenCalledTimes(1);
});

it("before the xterm exists every call is safe and copy is false", async () => {
  const { h } = handleFor(null);
  expect(h.hasSelection()).toBe(false);
  expect(await h.copy()).toBe(false);
  await h.paste();
  h.clear();
  h.reset();
  h.selectAll();
  h.focus();
  expect(readText).not.toHaveBeenCalled();
});

it("copyText writes the given text and is false when the clipboard refuses or is missing", async () => {
  expect(await copyText("3f2a-tab-id")).toBe(true);
  expect(writeText).toHaveBeenCalledWith("3f2a-tab-id");
  writeText.mockRejectedValueOnce(new Error("denied"));
  expect(await copyText("p2")).toBe(false);
  vi.stubGlobal("navigator", {});
  expect(await copyText("p2")).toBe(false);
});

it("lines gives the last lines of the buffer with blank tail lines dropped", () => {
  const buffer = [...Array.from({ length: 250 }, (_, i) => `line ${i}`), "", "   ", ""];
  const { term } = fakeTerm({}, buffer);
  const { h } = handleFor(term);
  const got = h.lines(CONTEXT_LINES);
  expect(got).toHaveLength(200);
  expect(got[0]).toBe("line 50");
  expect(got[199]).toBe("line 249");
  expect(handleFor(null).h.lines(10)).toEqual([]);
});

it("Copy Context: header lines, then the buffer", () => {
  const info = { title: "zsh", profile: "shell", path: "/demo/wt/xdev-oak", branch: "feat/x" };
  expect(terminalContext({ ...info, exitCode: 2 }, ["$ make", "error", "", ""])).toBe(
    ["Terminal: zsh (shell)", "Worktree: /demo/wt/xdev-oak (feat/x)", "Last exit code: 2", "--- last 200 lines ---", "$ make", "error"].join("\n"),
  );
  expect(terminalContext({ ...info, branch: null }, ["$"])).toBe(
    ["Terminal: zsh (shell)", "Worktree: /demo/wt/xdev-oak", "Last exit code: running", "--- last 200 lines ---", "$"].join("\n"),
  );
  expect(terminalContext({ ...info, exitCode: null }, [])).toContain("Last exit code: unknown");
});

it("Copy Context caps the buffer at 200 lines", () => {
  const lines = Array.from({ length: 300 }, (_, i) => `l${i}`);
  const text = terminalContext({ title: "t", profile: "shell", path: "/w", branch: null }, lines);
  const body = text.split("\n").slice(4);
  expect(body).toHaveLength(CONTEXT_LINES);
  expect(body[0]).toBe("l100");
});

it("copyContext writes the context built from the handle's buffer", async () => {
  const { term } = fakeTerm({}, ["$ ls", "a b", ""]);
  const { h } = handleFor(term);
  expect(await copyContext(h, { title: "zsh", profile: "shell", path: "/w", branch: "main", exitCode: 0 })).toBe(true);
  expect(writeText).toHaveBeenCalledWith(
    ["Terminal: zsh (shell)", "Worktree: /w (main)", "Last exit code: 0", "--- last 200 lines ---", "$ ls", "a b"].join("\n"),
  );
});

it("reset sends the current size again so the program redraws (B4)", () => {
  const { term } = fakeTerm({ cols: 120, rows: 40 });
  const { h, client } = handleFor(term);
  h.reset();
  expect(term.reset).toHaveBeenCalledTimes(1);
  expect(client.resize).toHaveBeenCalledWith(120, 40, true);
  expect(client.input).not.toHaveBeenCalled();
});

it("reset before the pty client exists only resets the xterm", () => {
  const { term } = fakeTerm();
  const h = createTerminalHandle({ term: () => term, client: () => null, find: vi.fn() });
  h.reset();
  expect(term.reset).toHaveBeenCalledTimes(1);
});
