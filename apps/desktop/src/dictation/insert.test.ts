import { expect, it, vi } from "vitest";
import type { TerminalHandle } from "@/terminal/Terminal";
import { insertDictation, joinSpacing, resolveTarget, spliceText, type EditorViewLike, type InsertDeps, type TargetElement } from "./insert";

// A stand-in element: `inside` lists the selectors `closest` matches.
function el(over: Partial<TargetElement> = {}, inside: string[] = []): TargetElement {
  const self: TargetElement = {
    tagName: "DIV",
    isConnected: true,
    closest: (sel: string) => (inside.includes(sel) ? self : null),
    ...over,
  };
  return self;
}

function textarea(value: string, caret: number, over: Partial<TargetElement> = {}) {
  const dispatchEvent = vi.fn((_event: Event) => true);
  const target = el({
    tagName: "TEXTAREA",
    value,
    selectionStart: caret,
    selectionEnd: caret,
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    dispatchEvent,
    ...over,
  });
  return { target, dispatchEvent };
}

function deps(over: Partial<InsertDeps> = {}): InsertDeps {
  return {
    findView: vi.fn(() => null),
    copy: vi.fn(async () => true),
    execInsert: vi.fn(() => true),
    setValue: vi.fn(),
    terminalAt: vi.fn(() => null),
    ...over,
  };
}

it("spliceText puts the text at the selection and moves the caret after it", () => {
  expect(spliceText("ab", 1, 1, "X")).toEqual({ value: "aXb", caret: 2 });
  expect(spliceText("abcd", 1, 3, "X")).toEqual({ value: "aXd", caret: 2 });
});

it("joinSpacing adds a space only after a non-space character", () => {
  expect(joinSpacing("hello", "world")).toBe(" world");
  expect(joinSpacing("hello ", "world")).toBe("world");
  expect(joinSpacing("line\n", "world")).toBe("world");
  expect(joinSpacing("", "world")).toBe("world");
});

it("resolveTarget sorts the focused element into terminal, editor, text or none", () => {
  expect(resolveTarget(el({}, [".xterm"])).kind).toBe("terminal");
  expect(resolveTarget(el({}, [".cm-editor"])).kind).toBe("editor");
  expect(resolveTarget(textarea("", 0).target).kind).toBe("text");
  expect(resolveTarget(el({ tagName: "INPUT", type: "text" })).kind).toBe("text");
  expect(resolveTarget(el({ tagName: "INPUT", type: "search" })).kind).toBe("text");
  expect(resolveTarget(el({ tagName: "INPUT", type: "password" })).kind).toBe("none");
  expect(resolveTarget(el({ tagName: "INPUT", type: "checkbox" })).kind).toBe("none");
  expect(resolveTarget(textarea("", 0, { disabled: true }).target).kind).toBe("none");
  expect(resolveTarget(textarea("", 0, { readOnly: true }).target).kind).toBe("none");
  expect(resolveTarget(textarea("", 0, { isConnected: false }).target).kind).toBe("none");
  expect(resolveTarget(el()).kind).toBe("none");
  expect(resolveTarget(null).kind).toBe("none");
});

it("no target: the text goes to the clipboard", async () => {
  const d = deps();
  expect(await insertDictation(resolveTarget(null), "hi", d)).toBe("copied");
  expect(d.copy).toHaveBeenCalledWith("hi");
});

it("a refused clipboard reports failed", async () => {
  const d = deps({ copy: vi.fn(async () => false) });
  expect(await insertDictation(resolveTarget(null), "hi", d)).toBe("failed");
});

it("text field: execCommand inserts with a joining space", async () => {
  const { target, dispatchEvent } = textarea("hello", 5);
  const d = deps();
  expect(await insertDictation(resolveTarget(target), "world", d)).toBe("inserted");
  expect(d.execInsert).toHaveBeenCalledWith(" world");
  expect(d.setValue).not.toHaveBeenCalled();
  expect(dispatchEvent).not.toHaveBeenCalled();
});

it("text field: when execCommand refuses, the value is set and one input event bubbles", async () => {
  const { target, dispatchEvent } = textarea("ab", 1);
  const d = deps({ execInsert: vi.fn(() => false) });
  expect(await insertDictation(resolveTarget(target), "X", d)).toBe("inserted");
  expect(d.setValue).toHaveBeenCalledWith(target, "a Xb");
  expect(target.setSelectionRange).toHaveBeenCalledWith(3, 3);
  expect(dispatchEvent).toHaveBeenCalledTimes(1);
  const event = dispatchEvent.mock.calls[0][0];
  expect(event.type).toBe("input");
  expect(event.bubbles).toBe(true);
});

it("terminal: the text goes through the handle's insertText", async () => {
  const insertText = vi.fn();
  const handle = { insertText } as unknown as TerminalHandle;
  const d = deps({ terminalAt: vi.fn(() => handle) });
  expect(await insertDictation(resolveTarget(el({}, [".xterm"])), "ls", d)).toBe("inserted");
  expect(insertText).toHaveBeenCalledWith("ls");
  expect(d.copy).not.toHaveBeenCalled();
});

it("terminal gone: copied", async () => {
  const d = deps();
  expect(await insertDictation(resolveTarget(el({}, [".xterm"])), "ls", d)).toBe("copied");
});

it("editor: a read-only view copies, a writable one gets a dictate transaction", async () => {
  const target = resolveTarget(el({}, [".cm-editor"]));
  const readOnly = { state: { readOnly: true }, dispatch: vi.fn() } as unknown as EditorViewLike;
  const ro = deps({ findView: vi.fn(() => readOnly) });
  expect(await insertDictation(target, "hi", ro)).toBe("copied");
  expect(readOnly.dispatch).not.toHaveBeenCalled();

  const dispatch = vi.fn();
  const replaceSelection = vi.fn((text: string) => ({ changes: { from: 0, insert: text } }));
  const view = {
    state: { readOnly: false, replaceSelection, selection: { main: { from: 3 } }, sliceDoc: () => "x" },
    dispatch,
    focus: vi.fn(),
  } as unknown as EditorViewLike;
  expect(await insertDictation(target, "hi", deps({ findView: vi.fn(() => view) }))).toBe("inserted");
  expect(replaceSelection).toHaveBeenCalledWith(" hi");
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(dispatch.mock.calls[0][0]).toMatchObject({ changes: { from: 0, insert: " hi" }, userEvent: "input.dictate" });
});
