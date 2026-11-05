import { expect, it, vi } from "vitest";
import { COPIED_MS, copyButtonHtml, copyCode, fillCodeCopy } from "./codeCopy";

const labels = { copy: "Copy code", copied: "Copied" };

function button(text: string | null) {
  const attrs = new Map<string, string>();
  return {
    attrs,
    innerHTML: "",
    closest: () => (text === null ? null : { querySelector: () => ({ textContent: text }) }),
    setAttribute: (n: string, v: string) => void attrs.set(n, v),
    removeAttribute: (n: string) => void attrs.delete(n),
  };
}

it("adds one labelled button per code block, once", () => {
  const html: string[] = [];
  const block = { querySelector: () => (html.length ? {} : null), insertAdjacentHTML: (_w: "beforeend", h: string) => void html.push(h) };
  fillCodeCopy({ querySelectorAll: () => [block] }, labels);
  fillCodeCopy({ querySelectorAll: () => [block] }, labels);
  expect(html).toEqual([copyButtonHtml(labels)]);
  expect(html[0]).toContain('aria-label="Copy code"');
});

it("copies the raw block text and shows Copied until the scheduled reset", async () => {
  const b = button("a < b\n");
  const write = vi.fn(async () => {});
  let reset: (() => void) | undefined;
  const later = vi.fn((fn: () => void) => void (reset = fn));
  await copyCode(b, { write, later, labels });
  expect(write).toHaveBeenCalledWith("a < b\n");
  expect(b.attrs.get("aria-label")).toBe("Copied");
  expect(b.attrs.get("data-copied")).toBe("true");
  expect(later).toHaveBeenCalledWith(expect.any(Function), COPIED_MS);
  reset!();
  expect(b.attrs.get("aria-label")).toBe("Copy code");
  expect(b.attrs.has("data-copied")).toBe(false);
});

it("leaves the button alone when the clipboard refuses", async () => {
  const b = button("x");
  const later = vi.fn();
  await copyCode(b, { write: async () => Promise.reject(new Error("denied")), later, labels });
  expect(b.attrs.size).toBe(0);
  expect(later).not.toHaveBeenCalled();
});
