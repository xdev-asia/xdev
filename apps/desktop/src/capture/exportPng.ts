import type { Shape } from "./annotModel";
import { draw, type Colors, type Drawable } from "./render";

/** The image with its shapes drawn in, as PNG bytes at the image's own size. */
export async function exportPng(image: Drawable, shapes: readonly Shape[], colors: Colors): Promise<Uint8Array> {
  const canvas = document.createElement("canvas");
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas");
  draw(ctx, image, shapes, colors, 1);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
  if (!blob) throw new Error("no png");
  return new Uint8Array(await blob.arrayBuffer());
}
