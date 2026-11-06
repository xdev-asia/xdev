import type { Api } from "@/api";
import { toApiError } from "@/api";
import type { PdfDoc, PdfEngine } from "./pdfEngine";
import { type PageMatch, clampPage, fitWidthScale, locateMatch, pageMatches, pdfErrorCode, zoomStep } from "./pdfModel";
import { stepMatch } from "./previewFind";

/** Space on each side of a page in fit mode, in CSS px (`--x-space-2`). */
export const PAGE_PADDING = 8;

export interface PdfFind {
  query: string;
  matches: PageMatch[];
  total: number;
  /** Index of the current match; -1 when there is none. */
  current: number;
  searching: boolean;
  /** Pages whose text has been read for the query. */
  scanned: number;
}

export interface PdfState {
  status: "loading" | "ready" | "error";
  error: string | null;
  bytes: number;
  pages: number;
  /** Page sizes in points. */
  sizes: { w: number; h: number }[];
  /** The current page, 1-based. */
  page: number;
  /** Counts the times the view was asked to scroll to `page`. */
  jump: number;
  mode: "fit" | "free";
  /** Page width in CSS px is its width in points x 96/72 x `scale`. */
  scale: number;
  /** Width of the pages box in px; null before it has one. */
  box: number | null;
  find: PdfFind;
}

const noFind: PdfFind = { query: "", matches: [], total: 0, current: -1, searching: false, scanned: 0 };

const initial: PdfState = { status: "loading", error: null, bytes: 0, pages: 0, sizes: [], page: 1, jump: 0, mode: "fit", scale: 1, box: null, find: noFind };

/** Loads one PDF through an engine and owns its page, zoom and find. Subscribe with useSyncExternalStore. */
export class PdfSession {
  private state: PdfState = initial;
  private listeners = new Set<() => void>();
  private gen = 0;
  private searchGen = 0;
  private doc: PdfDoc | null = null;
  private disposed = false;
  private texts = new Map<number, Promise<string[]>>();

  constructor(
    private api: Pick<Api, "fileBytes">,
    private engine: PdfEngine,
    private worktree: string,
    private rel: string,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = (): PdfState => this.state;
  /** The open document, for the view's render calls; null until ready. */
  document(): PdfDoc | null {
    return this.doc;
  }
  private set(patch: Partial<PdfState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private release(): void {
    this.doc?.destroy();
    this.doc = null;
  }

  async load(): Promise<void> {
    const gen = ++this.gen;
    this.searchGen++;
    this.release();
    this.texts = new Map();
    this.set({ ...initial, box: this.state.box });
    let data: Uint8Array;
    try {
      data = await this.api.fileBytes(this.worktree, this.rel);
    } catch (e) {
      if (gen === this.gen) this.set({ status: "error", error: toApiError(e).code });
      return;
    }
    if (gen !== this.gen) return;
    let doc: PdfDoc | null = null;
    try {
      doc = await this.engine.open(data);
      const sizes = await Promise.all(Array.from({ length: doc.pages }, (_, i) => doc!.size(i + 1)));
      if (gen !== this.gen) {
        doc.destroy();
        return;
      }
      this.doc = doc;
      this.set({ status: "ready", bytes: data.byteLength, pages: doc.pages, sizes, scale: this.fitScale(sizes, this.state.box) });
    } catch (e) {
      doc?.destroy();
      if (gen === this.gen) this.set({ status: "error", error: pdfErrorCode(e) });
    }
  }

  /** Destroys the document and ignores a load or a search still in flight. */
  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.searchGen++;
    this.release();
    this.listeners.clear();
  }

  private fitScale(sizes: readonly { w: number; h: number }[], box: number | null): number {
    if (box === null || sizes.length === 0) return 1;
    return fitWidthScale(Math.max(...sizes.map((s) => s.w)), box, PAGE_PADDING);
  }

  /** Jumps to a page (a click or a typed number). */
  setPage(page: number): void {
    this.set({ page: clampPage(page, this.state.pages), jump: this.state.jump + 1 });
  }
  /** The page the scroll position is on; the view does not move. */
  scrolled(page: number): void {
    const next = clampPage(page, this.state.pages);
    if (next !== this.state.page) this.set({ page: next });
  }

  setBox(width: number): void {
    const { box, mode, sizes } = this.state;
    if (box === width) return;
    this.set(mode === "fit" ? { box: width, scale: this.fitScale(sizes, width) } : { box: width });
  }
  zoomIn(): void {
    this.set({ mode: "free", scale: zoomStep(this.state.scale, 1) });
  }
  zoomOut(): void {
    this.set({ mode: "free", scale: zoomStep(this.state.scale, -1) });
  }
  fit(): void {
    this.set({ mode: "fit", scale: this.fitScale(this.state.sizes, this.state.box) });
  }
  actual(): void {
    this.set({ mode: "free", scale: 1 });
  }

  private pageText(p: number): Promise<string[]> {
    let t = this.texts.get(p);
    if (!t) {
      const doc = this.doc;
      t = doc ? doc.text(p).catch(() => []) : Promise.resolve([]);
      this.texts.set(p, t);
    }
    return t;
  }

  /** Finds `query` through the whole document, page by page; only the newest query lands. */
  async search(query: string): Promise<void> {
    const gen = ++this.searchGen;
    const pages = this.state.pages;
    if (!query || !this.doc) {
      this.set({ find: { ...noFind, query } });
      return;
    }
    this.set({ find: { ...noFind, query, searching: true } });
    const matches: PageMatch[] = [];
    for (let p = 1; p <= pages; p++) {
      const items = await this.pageText(p);
      if (gen !== this.searchGen || this.disposed) return;
      for (const m of pageMatches([items], query)) matches.push({ ...m, page: p - 1 });
      const first = this.state.find.current === -1 && matches.length > 0;
      this.set({ find: { query, matches: [...matches], total: matches.length, current: first ? 0 : this.state.find.current, searching: p < pages, scanned: p } });
      if (first) this.reveal();
    }
  }

  /** Moves to the next (`1`) or previous (`-1`) match, wrapping. */
  step(dir: 1 | -1): void {
    const { find } = this.state;
    const current = stepMatch(find.current, find.total, dir);
    if (current < 0) return;
    this.set({ find: { ...find, current } });
    this.reveal();
  }

  private reveal(): void {
    const at = locateMatch(this.state.find.matches, this.state.find.current);
    if (at) this.setPage(at.page + 1);
  }
}
