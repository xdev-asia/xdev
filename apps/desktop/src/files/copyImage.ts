/** The pixel ratio of a copied PNG, and the longest side it may have. */
export const COPY_RATIO = 2;
export const COPY_MAX_SIDE = 16384;
/** The most pixels a copied PNG canvas may have (browsers refuse or crash on larger canvases). */
export const COPY_MAX_AREA = 32_000_000;

/** The canvas size for an image of `w` x `h`: 2x, scaled down so no side and not the total area passes its cap. */
export function pngSize(w: number, h: number): { w: number; h: number } {
  const longest = Math.max(w, h, 1);
  const bySide = Math.min(COPY_RATIO, COPY_MAX_SIDE / longest);
  const k = Math.min(bySide, Math.sqrt(COPY_MAX_AREA / Math.max(1, w * h)));
  return { w: Math.max(1, Math.floor(w * k)), h: Math.max(1, Math.floor(h * k)) };
}

/** What drawing and writing need; the default uses the page's canvas and clipboard. */
export interface CopyEnv {
  canvas(w: number, h: number): { draw(img: CanvasImageSource): void; toPng(): Promise<Blob | null> };
  write(png: Blob): Promise<void>;
}

const browserEnv: CopyEnv = {
  canvas(w, h) {
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    return {
      draw(img) {
        canvas.getContext("2d")?.drawImage(img, 0, 0, w, h);
      },
      toPng: () => new Promise((resolve) => canvas.toBlob(resolve, "image/png")),
    };
  },
  write: (png) => navigator.clipboard.write([new ClipboardItem({ "image/png": png })]),
};

/** Copies `img` to the clipboard as a PNG. False when the canvas, the encoder or the clipboard refuses. */
export async function copyPng(img: { naturalWidth: number; naturalHeight: number }, env: CopyEnv = browserEnv): Promise<boolean> {
  try {
    if (img.naturalWidth <= 0 || img.naturalHeight <= 0) return false;
    const size = pngSize(img.naturalWidth, img.naturalHeight);
    const canvas = env.canvas(size.w, size.h);
    canvas.draw(img as unknown as CanvasImageSource);
    const png = await canvas.toPng();
    if (!png) return false;
    await env.write(png);
    return true;
  } catch {
    return false;
  }
}
