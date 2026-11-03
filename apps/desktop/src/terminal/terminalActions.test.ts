import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PtyClient } from "./ptyClient";
import { createTerminalHandle, type XTermLike } from "./terminalActions";

// A stand-in xterm: a buffer of lines and spies for every call the handle makes.
function fakeTerm(over: Partial<XTermLike> = {}, buffer: string[] = []) {
  let selection = "";
  const term = {
    cols: 80,
    rows: 24,
    getSelection: vi.fn(() => selection),
    hasSelection: vi.fn(() => selection.length > 0),
    paste: vi.fn(),
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
