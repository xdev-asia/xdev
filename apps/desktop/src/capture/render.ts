import type { ColorKey, Shape } from "./annotModel";

/** The colours and font a drawing uses, resolved from the app's tokens. */
export type Colors = Record<ColorKey | "halo", string> & { font: string };

export type Drawable = { width: number; height: number };

/** Side of the square a blur averages to one colour, in canvas pixels. */
export const BLUR_BLOCK = 12;

/** The custom property behind each colour; `halo` is the dark outline of a note. */
const TOKENS: Record<ColorKey | "halo", string> = {
  danger: "--danger",
  warning: "--warn",
  accent: "--accent",
  fg: "--text-1",
  halo: "--bg-0",
};

/** The colours from the custom properties on `el`, and its font family. */
export function resolveColors(el: Element): Colors {
  const style = getComputedStyle(el);
  const read = (name: string) => style.getPropertyValue(name).trim();
  return {
    danger: read(TOKENS.danger),
    warning: read(TOKENS.warning),
    accent: read(TOKENS.accent),
    fg: read(TOKENS.fg),
    halo: read(TOKENS.halo),
    font: style.fontFamily,
  };
}

/** The stroke of an arrow or a box on an image `width` pixels wide. */
export const strokeFor = (width: number): number => Math.max(2, Math.round((3 * width) / 1280));

type Pixels = { data: Uint8ClampedArray; width: number; height: number };

/** Replaces every `block`-sized square of `img` by its average colour, in place. */
export function pixelate(img: Pixels, block = BLUR_BLOCK): void {
  const { data, width, height } = img;
  for (let by = 0; by < height; by += block) {
    for (let bx = 0; bx < width; bx += block) {
      const x1 = Math.min(bx + block, width);
      const y1 = Math.min(by + block, height);
      const sum = [0, 0, 0, 0];
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = (y * width + x) * 4;
          for (let c = 0; c < 4; c++) sum[c] += data[i + c];
        }
      }
      const n = (x1 - bx) * (y1 - by);
      const avg = sum.map((s) => Math.round(s / n));
      for (let y = by; y < y1; y++) {
        for (let x = bx; x < x1; x++) {
          const i = (y * width + x) * 4;
          for (let c = 0; c < 4; c++) data[i + c] = avg[c];
        }
      }
    }
  }
}

function blur(ctx: CanvasRenderingContext2D, s: Extract<Shape, { tool: "blur" }>, scale: number): void {
  const x = Math.max(0, Math.floor(s.x * scale));
  const y = Math.max(0, Math.floor(s.y * scale));
  const w = Math.min(ctx.canvas.width, Math.ceil((s.x + s.w) * scale)) - x;
  const h = Math.min(ctx.canvas.height, Math.ceil((s.y + s.h) * scale)) - y;
  if (w <= 0 || h <= 0) return;
  const region = ctx.getImageData(x, y, w, h);
  pixelate(region);
  ctx.putImageData(region, x, y);
}

function arrow(ctx: CanvasRenderingContext2D, s: Extract<Shape, { tool: "arrow" }>, color: string, stroke: number): void {
  const angle = Math.atan2(s.y2 - s.y1, s.x2 - s.x1);
  const length = Math.hypot(s.x2 - s.x1, s.y2 - s.y1);
  // The head is at most half the arrow, so a short arrow is still mostly head and shaft.
  const head = Math.min(stroke * 5, length / 2);
  const base = { x: s.x2 - Math.cos(angle) * head, y: s.y2 - Math.sin(angle) * head };
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = stroke;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(s.x1, s.y1);
  ctx.lineTo(base.x, base.y);
  ctx.stroke();
  const spread = head * 0.5;
  ctx.beginPath();
  ctx.moveTo(s.x2, s.y2);
  ctx.lineTo(base.x + Math.sin(angle) * spread, base.y - Math.cos(angle) * spread);
  ctx.lineTo(base.x - Math.sin(angle) * spread, base.y + Math.cos(angle) * spread);
  ctx.closePath();
  ctx.fill();
}

/**
 * Draws the base image, then the shapes: blurs first (they read the base, and the pixels stay
 * changed in an exported PNG), then arrows, boxes and notes. `scale` is canvas pixels per image
 * pixel; shape coordinates are in image pixels.
 */
export function draw(ctx: CanvasRenderingContext2D, image: Drawable, shapes: readonly Shape[], colors: Colors, scale = 1): void {
  ctx.drawImage(image as CanvasImageSource, 0, 0, image.width * scale, image.height * scale);
  for (const s of shapes) if (s.tool === "blur") blur(ctx, s, scale);
  const stroke = strokeFor(image.width);
  ctx.save();
  ctx.scale(scale, scale);
  for (const s of shapes) if (s.tool === "arrow") arrow(ctx, s, colors[s.color], stroke);
  for (const s of shapes) {
    if (s.tool !== "box") continue;
    ctx.strokeStyle = colors[s.color];
    ctx.lineWidth = stroke;
    ctx.lineJoin = "round";
    ctx.strokeRect(s.x, s.y, s.w, s.h);
  }
  for (const s of shapes) {
    if (s.tool !== "text") continue;
    ctx.font = `${s.size}px ${colors.font}`;
    ctx.textBaseline = "top";
    ctx.lineJoin = "round";
    ctx.lineWidth = Math.max(3, s.size / 5);
    ctx.strokeStyle = colors.halo;
    ctx.strokeText(s.text, s.x, s.y);
    ctx.fillStyle = colors[s.color];
    ctx.fillText(s.text, s.x, s.y);
  }
  ctx.restore();
}
