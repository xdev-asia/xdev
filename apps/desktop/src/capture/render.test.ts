import { describe, expect, it } from "vitest";
import type { Shape } from "./annotModel";
import { BLUR_BLOCK, draw, pixelate, strokeFor, type Colors } from "./render";

const colors: Colors = { danger: "C-danger", warning: "C-warn", accent: "C-accent", fg: "C-fg", halo: "C-halo", font: "F-ui" };

type Call = { fn: string; args: unknown[]; style?: string; width?: number };

/** A 2D context that records its calls, with the colour and line width in force at each. */
function fakeCtx(size = { width: 100, height: 100 }, pixels?: ImageData) {
  const calls: Call[] = [];
  const state: Record<string, unknown> = {};
  const ctx = new Proxy(
    { canvas: size },
    {
      get(target, prop: string) {
        if (prop in target) return (target as Record<string, unknown>)[prop];
        if (prop in state) return state[prop];
        return (...args: unknown[]) => {
          calls.push({ fn: prop, args, style: String(prop.startsWith("fill") ? state.fillStyle : state.strokeStyle), width: state.lineWidth as number });
          if (prop === "getImageData") return pixels;
          return undefined;
        };
      },
      set(_t, prop: string, value) {
        state[prop] = value;
        if (prop === "font") calls.push({ fn: "font", args: [value] });
        return true;
      },
    },
  );
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls };
}

const image = { width: 1280, height: 720 };
const arrow: Shape = { id: "a", tool: "arrow", color: "danger", x1: 10, y1: 10, x2: 210, y2: 10 };

describe("pixelate", () => {
  it("averages each 12x12 block over the region", () => {
    // 24x12: the left block is 0 and 100 alternating columns, the right block is flat 200.
    const width = 24;
    const height = 12;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        const v = x < 12 ? (x % 2 === 0 ? 0 : 100) : 200;
        data.set([v, v, v, 255], i);
      }
    }
    pixelate({ data, width, height });
    expect(Array.from(data.slice(0, 4))).toEqual([50, 50, 50, 255]);
    expect(Array.from(data.slice((11 * width + 11) * 4, (11 * width + 11) * 4 + 4))).toEqual([50, 50, 50, 255]);
    expect(Array.from(data.slice(12 * 4, 12 * 4 + 4))).toEqual([200, 200, 200, 255]);
  });

  it("averages a partial block at the edge", () => {
    const data = new Uint8ClampedArray(14 * 1 * 4);
    for (let x = 0; x < 14; x++) data.set([x < 12 ? 10 : 30, 0, 0, 255], x * 4);
    pixelate({ data, width: 14, height: 1 });
    expect(data[12 * 4]).toBe(30);
    expect(data[13 * 4]).toBe(30);
    expect(data[0]).toBe(10);
    expect(BLUR_BLOCK).toBe(12);
  });
});

describe("draw", () => {
  it("draws the base image first, and a blur reads then writes the region", () => {
    const px = { data: new Uint8ClampedArray(24 * 12 * 4), width: 24, height: 12 } as unknown as ImageData;
    const { ctx, calls } = fakeCtx({ width: 1280, height: 720 }, px);
    draw(ctx, image, [{ id: "b", tool: "blur", color: "danger", x: 10, y: 20, w: 24, h: 12 }], colors);
    expect(calls[0].fn).toBe("drawImage");
    const read = calls.find((c) => c.fn === "getImageData");
    expect(read?.args).toEqual([10, 20, 24, 12]);
    expect(calls.find((c) => c.fn === "putImageData")?.args).toEqual([px, 10, 20]);
  });

  it("blurs before it strokes anything, whatever the order of the shapes", () => {
    const px = { data: new Uint8ClampedArray(12 * 12 * 4), width: 12, height: 12 } as unknown as ImageData;
    const { ctx, calls } = fakeCtx({ width: 1280, height: 720 }, px);
    draw(ctx, image, [arrow, { id: "b", tool: "blur", color: "fg", x: 0, y: 0, w: 12, h: 12 }], colors);
    const names = calls.map((c) => c.fn);
    expect(names.indexOf("putImageData")).toBeLessThan(names.indexOf("stroke"));
  });

  it("an arrow has a shaft and a filled head, in the resolved colour, with the scaled stroke", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, image, [arrow], colors);
    const stroke = calls.find((c) => c.fn === "stroke");
    const fill = calls.find((c) => c.fn === "fill");
    expect(stroke?.style).toBe("C-danger");
    expect(stroke?.width).toBe(strokeFor(1280));
    expect(fill?.style).toBe("C-danger");
    expect(calls.filter((c) => c.fn === "lineTo")).toHaveLength(3);
  });

  it("the stroke is 3 px at 1280 wide, 6 at 2560, and never under 2", () => {
    expect(strokeFor(1280)).toBe(3);
    expect(strokeFor(2560)).toBe(6);
    expect(strokeFor(100)).toBe(2);
  });

  it("a box is a stroke only", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, image, [{ id: "x", tool: "box", color: "warning", x: 5, y: 6, w: 70, h: 80 }], colors);
    const box = calls.find((c) => c.fn === "strokeRect");
    expect(box?.args).toEqual([5, 6, 70, 80]);
    expect(box?.style).toBe("C-warn");
    expect(calls.some((c) => c.fn === "fillRect" || c.fn === "fill")).toBe(false);
  });

  it("text gets a halo from the resolved halo colour, then the fill, in the UI font at its size", () => {
    const { ctx, calls } = fakeCtx();
    draw(ctx, image, [{ id: "t", tool: "text", color: "accent", x: 9, y: 8, text: "here", size: 30 }], colors);
    expect(calls.find((c) => c.fn === "font")?.args[0]).toBe("30px F-ui");
    const names = calls.map((c) => c.fn);
    expect(names.indexOf("strokeText")).toBeLessThan(names.indexOf("fillText"));
    expect(calls.find((c) => c.fn === "strokeText")?.style).toBe("C-halo");
    expect(calls.find((c) => c.fn === "fillText")?.style).toBe("C-accent");
    expect(calls.find((c) => c.fn === "fillText")?.args).toEqual(["here", 9, 8]);
  });

  it("every colour key comes from the map", () => {
    const { ctx, calls } = fakeCtx();
    draw(
      ctx,
      image,
      (["danger", "warning", "accent", "fg"] as const).map((color, i) => ({ id: `b${i}`, tool: "box", color, x: 0, y: 0, w: 10, h: 10 }) as Shape),
      colors,
    );
    expect(calls.filter((c) => c.fn === "strokeRect").map((c) => c.style)).toEqual(["C-danger", "C-warn", "C-accent", "C-fg"]);
  });
});
