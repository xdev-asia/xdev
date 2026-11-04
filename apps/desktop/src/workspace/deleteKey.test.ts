import { expect, it } from "vitest";
import { isDeleteKey, typingIn } from "./deleteKey";

const k = (over: Partial<Parameters<typeof isDeleteKey>[0]> = {}) => ({ key: "Backspace", ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, ...over });

it("matches Ctrl+Shift+Backspace, or Cmd on macOS", () => {
  expect(isDeleteKey(k(), false)).toBe(true);
  expect(isDeleteKey(k({ shiftKey: false }), false)).toBe(false);
  expect(isDeleteKey(k(), true)).toBe(false);
  expect(isDeleteKey(k({ ctrlKey: false, metaKey: true }), true)).toBe(true);
  expect(isDeleteKey(k({ key: "Delete" }), false)).toBe(false);
});

it("typing is false without a DOM element", () => {
  expect(typingIn(null)).toBe(false);
  expect(typingIn({})).toBe(false);
});
