import { afterEach, describe, expect, it, vi } from "vitest";
import { exportPng } from "./exportPng";
import type { Colors } from "./render";

const colors: Colors = { danger: "a", warning: "b", accent: "c", fg: "d", halo: "e", font: "f" };

/** The tests run without a DOM, so the canvas the export makes is a stub. */
function stubCanvas(over: { ctx?: unknown; blob?: Blob | null }) {
  const drawn: unknown[][] = [];
  const canvas: {
    width: number;
    height: number;
    type: string;
    size: { w: number; h: number };
    getContext(): unknown;
    toBlob(cb: (b: Blob | null) => void, type: string): void;
  } = {
    width: 0,
    height: 0,
    type: "",
    size: { w: 0, h: 0 },
    getContext: () => over.ctx === undefined ? new Proxy({}, { get: (_t, prop) => (...args: unknown[]) => void drawn.push([prop, ...args]), set: () => true }) : over.ctx,
    toBlob(cb: (b: Blob | null) => void, type: string) {
      canvas.type = type;
      canvas.size = { w: canvas.width, h: canvas.height };
      cb(over.blob === undefined ? new Blob([new Uint8Array([137, 80, 78, 71])]) : over.blob);
    },
  };
  vi.stubGlobal("document", { createElement: () => canvas });
  return { canvas, drawn };
}

afterEach(() => vi.unstubAllGlobals());

describe("exportPng", () => {
  it("makes a canvas at the image's size and returns the PNG bytes", async () => {
    const { canvas, drawn } = stubCanvas({});
    const bytes = await exportPng({ width: 640, height: 360 }, [], colors);
    expect(canvas.size).toEqual({ w: 640, h: 360 });
    expect(canvas.type).toBe("image/png");
    expect(Array.from(bytes)).toEqual([137, 80, 78, 71]);
    expect(drawn[0]).toEqual(["drawImage", { width: 640, height: 360 }, 0, 0, 640, 360]);
  });

  it("fails when the canvas gives no context", async () => {
    stubCanvas({ ctx: null });
    await expect(exportPng({ width: 1, height: 1 }, [], colors)).rejects.toThrow();
  });

  it("fails when the canvas gives no blob", async () => {
    stubCanvas({ blob: null });
    await expect(exportPng({ width: 1, height: 1 }, [], colors)).rejects.toThrow();
  });
});
