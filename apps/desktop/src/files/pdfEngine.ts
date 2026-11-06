import { canvasScale } from "./pdfModel";

/** One page being drawn; `cancel` stops it, `done` settles when it has finished or was cancelled. */
export interface PdfRender {
  done: Promise<void>;
  cancel(): void;
}

/** An open document. Pages are 1-based. */
export interface PdfDoc {
  /** The number of pages. */
  pages: number;
  /** Width and height of page `p` in points. */
  size(p: number): Promise<{ w: number; h: number }>;
  /** Draws page `p` into `canvas` and its selectable text into `layer`; `scale` is CSS pixels per point over 96/72. */
  render(p: number, canvas: HTMLCanvasElement, layer: HTMLElement, scale: number, dpr: number): PdfRender;
  /** The text items of page `p`, in reading order. */
  text(p: number): Promise<string[]>;
  destroy(): void;
}

export interface PdfEngine {
  open(bytes: Uint8Array): Promise<PdfDoc>;
}

type Lib = typeof import("pdfjs-dist/legacy/build/pdf.mjs");

let lib: Promise<Lib> | null = null;

/** Loads pdf.js and its worker on first use; the main chunk never holds either. */
function loadLib(): Promise<Lib> {
  lib ??= (async () => {
    const [pdfjs, worker] = await Promise.all([import("pdfjs-dist/legacy/build/pdf.mjs"), import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url")]);
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  })();
  // A failed load is tried again on the next open.
  lib.catch(() => {
    lib = null;
  });
  return lib;
}

/** pdf.js, the only place that names it. */
export const pdfjsEngine: PdfEngine = {
  async open(bytes) {
    const pdfjs = await loadLib();
    const task = pdfjs.getDocument({ data: bytes, useSystemFonts: true, stopAtErrors: false });
    const doc = await task.promise;
    return {
      pages: doc.numPages,
      async size(p) {
        const v = (await doc.getPage(p)).getViewport({ scale: 1 });
        return { w: v.width, h: v.height };
      },
      render(p, canvas, layer, scale, dpr) {
        let stop = false;
        const cancels: Array<() => void> = [];
        const done = (async () => {
          const page = await doc.getPage(p);
          if (stop) return;
          const viewport = page.getViewport({ scale: scale * (96 / 72) });
          const px = canvasScale(viewport.width, viewport.height, dpr);
          canvas.width = Math.floor(viewport.width * px);
          canvas.height = Math.floor(viewport.height * px);
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no 2d context");
          const paint = page.render({ canvas, canvasContext: ctx, viewport, transform: [px, 0, 0, px, 0, 0] });
          const text = new pdfjs.TextLayer({ textContentSource: page.streamTextContent(), container: layer, viewport });
          cancels.push(
            () => paint.cancel(),
            () => text.cancel(),
          );
          try {
            await Promise.all([paint.promise, text.render()]);
          } catch (e) {
            if ((e as { name?: string }).name !== "RenderingCancelledException") throw e;
          }
        })();
        return {
          done,
          cancel() {
            stop = true;
            for (const c of cancels) c();
          },
        };
      },
      async text(p) {
        const content = await (await doc.getPage(p)).getTextContent();
        return content.items.flatMap((i) => ("str" in i ? [i.str] : []));
      },
      destroy() {
        void task.destroy();
      },
    };
  },
};
