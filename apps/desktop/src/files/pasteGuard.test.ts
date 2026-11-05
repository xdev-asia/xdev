import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { expect, it, vi } from "vitest";
import { PASTE_MAX_BYTES, pasteGuard, pasteHandler, pasteTooLarge } from "./pasteGuard";

it("16 MiB is the cap", () => {
  expect(PASTE_MAX_BYTES).toBe(16 * 1024 * 1024);
  expect(pasteTooLarge("a".repeat(PASTE_MAX_BYTES))).toBe(false);
  expect(pasteTooLarge("a".repeat(PASTE_MAX_BYTES + 1))).toBe(true);
});

it("counts UTF-8 bytes not chars", () => {
  // 3 bytes each: under the cap as characters, over it as bytes.
  const chars = Math.floor(PASTE_MAX_BYTES / 3) + 1;
  expect(pasteTooLarge("€".repeat(chars))).toBe(true);
  expect(pasteTooLarge("€".repeat(chars - 1))).toBe(false);
  expect(pasteTooLarge("")).toBe(false);
});

const eventWith = (text: string | null) => {
  const preventDefault = vi.fn();
  const event = {
    preventDefault,
    clipboardData: text === null ? null : { getData: (kind: string) => (kind === "text/plain" ? text : "") },
  } as unknown as ClipboardEvent;
  return { event, preventDefault };
};
const view = {} as EditorView;

it("blocks a paste over the cap and calls back", () => {
  const onTooLarge = vi.fn();
  const paste = pasteHandler(onTooLarge);
  const { event, preventDefault } = eventWith("a".repeat(PASTE_MAX_BYTES + 1));
  expect(paste(event, view)).toBe(true);
  expect(preventDefault).toHaveBeenCalled();
  expect(onTooLarge).toHaveBeenCalledTimes(1);
});

it("lets a small paste through", () => {
  const onTooLarge = vi.fn();
  const paste = pasteHandler(onTooLarge);
  for (const text of ["hello", null, ""]) {
    const { event, preventDefault } = eventWith(text);
    expect(paste(event, view)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
  }
  expect(onTooLarge).not.toHaveBeenCalled();
});

it("is an editor extension", () => {
  expect(EditorState.create({ extensions: [pasteGuard(() => {})] })).toBeTruthy();
});
