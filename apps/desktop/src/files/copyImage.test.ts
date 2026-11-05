import { describe, expect, it, vi } from "vitest";
import { COPY_MAX_SIDE, copyPng, pngSize, type CopyEnv } from "./copyImage";

const img = { naturalWidth: 100, naturalHeight: 50 };

function env(over: Partial<CopyEnv> = {}) {
  const sizes: [number, number][] = [];
  const write = vi.fn(async () => {});
  const value: CopyEnv = {
    canvas(w, h) {
      sizes.push([w, h]);
      return { draw() {}, toPng: async () => new Blob(["x"], { type: "image/png" }) };
    },
    write,
    ...over,
  };
  return { value, sizes, write };
}

describe("pngSize", () => {
  it("draws at 2x", () => {
    expect(pngSize(100, 50)).toEqual({ w: 200, h: 100 });
  });
  it("keeps the longest side within 16384", () => {
    const size = pngSize(10000, 5000);
    expect(Math.max(size.w, size.h)).toBe(COPY_MAX_SIDE);
    expect(size.h).toBe(COPY_MAX_SIDE / 2);
  });
});

describe("copyPng", () => {
  it("writes a PNG at twice the size", async () => {
    const e = env();
    expect(await copyPng(img, e.value)).toBe(true);
    expect(e.sizes).toEqual([[200, 100]]);
    expect(e.write).toHaveBeenCalledOnce();
  });
  it("is false, not a throw, when the clipboard refuses", async () => {
    const e = env({ write: async () => { throw new Error("denied"); } });
    expect(await copyPng(img, e.value)).toBe(false);
  });
  it("is false when the canvas cannot encode, or the image has no size", async () => {
    expect(await copyPng(img, env({ canvas: () => ({ draw() {}, toPng: async () => null }) }).value)).toBe(false);
    expect(await copyPng({ naturalWidth: 0, naturalHeight: 0 }, env().value)).toBe(false);
  });
});
