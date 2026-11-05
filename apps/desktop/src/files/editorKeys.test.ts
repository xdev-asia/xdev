import type { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { editorKeymap, editorKeys } from "./editorKeys";

const view = {} as EditorView;

function setup() {
  const onToggleWrap = vi.fn();
  const onChange = vi.fn();
  const bindings = editorKeymap({ onToggleWrap, onChange });
  const run = (key: string) => bindings.find((b) => b.key === key)?.run?.(view);
  return { onToggleWrap, onChange, run };
}

it("Alt-z calls toggle wrap", () => {
  const { onToggleWrap, onChange, run } = setup();
  expect(run("Alt-z")).toBe(true);
  expect(onToggleWrap).toHaveBeenCalledTimes(1);
  expect(onChange).not.toHaveBeenCalled();
});

it("F7 and Shift-F7 call change with 1 and -1", () => {
  const { onToggleWrap, onChange, run } = setup();
  expect(run("F7")).toBe(true);
  expect(run("Shift-F7")).toBe(true);
  expect(onChange.mock.calls).toEqual([[1], [-1]]);
  expect(onToggleWrap).not.toHaveBeenCalled();
});

it("is an editor extension", () => {
  expect(editorKeys({ onToggleWrap: () => {}, onChange: () => {} })).toBeTruthy();
});
