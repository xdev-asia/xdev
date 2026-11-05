import { MAX_ZOOM, MIN_ZOOM, clampZoom, fitScale, percentOf, stepZoom, zoomAt, type PanZoomState } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { toApiError } from "@/api";
import { mimeOf } from "./viewer";

export interface Size {
  w: number;
  h: number;
}
export const FIT_PADDING = 16;

export interface ImageState {
  status: "loading" | "ready" | "error";
  error: string | null;
  url: string | null;
  bytes: number;
  nat: Size | null;
  box: Size | null;
  /** Zoom on top of fit: 1 is fit. */
  zoom: number;
  /** Pan; null while the image is centred (fit mode). */
  pan: { x: number; y: number } | null;
}

export interface UrlApi {
  create(blob: Blob): string;
  revoke(url: string): void;
}
const browserUrl: UrlApi = { create: (b) => URL.createObjectURL(b), revoke: (u) => URL.revokeObjectURL(u) };

const initial: ImageState = { status: "loading", error: null, url: null, bytes: 0, nat: null, box: null, zoom: 1, pan: null };

/** Loads one image's bytes into an object URL and owns its zoom and pan. Subscribe with useSyncExternalStore. */
export class ImageSession {
  private state: ImageState = initial;
  private listeners = new Set<() => void>();
  private gen = 0;
  private owns = true;
  private detach: (() => void) | null = null;
  private parent: ImageSession | null = null;
  constructor(
    private api: Pick<Api, "fileBytes">,
    private worktree: string,
    private rel: string,
    private urls: UrlApi = browserUrl,
  ) {}

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  get = (): ImageState => this.state;
  private set(patch: Partial<ImageState>): void {
    this.state = { ...this.state, ...patch };
    this.listeners.forEach((fn) => fn());
  }
  private revoke(): void {
    if (this.owns && this.state.url) this.urls.revoke(this.state.url);
  }

  async load(): Promise<void> {
    const gen = ++this.gen;
    this.revoke();
    this.set({ ...initial, box: this.state.box });
    try {
      const data = await this.api.fileBytes(this.worktree, this.rel);
      if (gen !== this.gen) return;
      const url = this.urls.create(new Blob([data as BlobPart], { type: mimeOf(this.rel) }));
      this.set({ status: "ready", url, bytes: data.byteLength });
    } catch (e) {
      if (gen === this.gen) this.set({ status: "error", error: toApiError(e).code });
    }
  }

  /** Revokes the URL and ignores a load still in flight. */
  dispose(): void {
    this.detach?.();
    this.detach = null;
    this.gen++;
    this.revoke();
    this.listeners.clear();
    this.state = { ...this.state, url: null };
  }

  /** A second view of the image (the expand dialog) with its own zoom. It follows this session's URL and status, and never revokes the URL. */
  view(): ImageSession {
    const v = new ImageSession(this.api, this.worktree, this.rel, this.urls);
    v.owns = false;
    v.state = { ...this.state, box: null, zoom: 1, pan: null };
    v.parent = this;
    v.attach();
    return v;
  }
  /** (Re)starts following the parent of a view; a no-op when already following. `dispose` stops it. */
  attach(): void {
    const parent = this.parent;
    if (!parent || this.detach) return;
    const sync = (): void => {
      const { status, error, url, bytes } = parent.state;
      const own = this.state;
      if (own.status !== status || own.error !== error || own.url !== url || own.bytes !== bytes) this.set({ status, error, url, bytes });
    };
    this.detach = parent.subscribe(sync);
    sync();
  }
  setNatural(w: number, h: number): void {
    this.set({ nat: { w, h } });
  }
  setBox(w: number, h: number): void {
    const box = this.state.box;
    if (!box || box.w !== w || box.h !== h) this.set({ box: { w, h } });
  }

  private get upscale(): boolean {
    return /\.svg$/i.test(this.rel);
  }
  /** Scale that fits the image in the box. */
  fit(): number {
    const { nat, box } = this.state;
    return nat && box ? fitScale(nat, box, { padding: FIT_PADDING, upscale: this.upscale }) : 1;
  }
  /** The scale the image is drawn at. */
  scale(): number {
    return this.fit() * this.state.zoom;
  }
  /** Where the image's top-left sits in the box. */
  origin(): { x: number; y: number } {
    const { nat, box, pan } = this.state;
    if (pan) return pan;
    if (!nat || !box) return { x: 0, y: 0 };
    const s = this.scale();
    return { x: (box.w - nat.w * s) / 2, y: (box.h - nat.h * s) / 2 };
  }
  /** Shown percentage; null before the image has a size. */
  percent(): number | null {
    return this.state.nat && this.state.box ? percentOf(this.state.zoom, this.fit()) : null;
  }

  /** Highest zoom on top of fit: 8x, or whatever shows 100% of the image's pixels when fit is small. */
  private maxZoom(): number {
    return Math.max(MAX_ZOOM, 1 / this.fit());
  }
  /** The zoom limits as absolute scales, for PanZoom: relative to fit, so a big image can still zoom out. */
  limits(): { min: number; max: number } {
    const fit = this.fit();
    return { min: MIN_ZOOM * fit, max: this.maxZoom() * fit };
  }
  private clamp(zoom: number): number {
    return clampZoom(zoom, MIN_ZOOM, this.maxZoom());
  }

  reset(): void {
    this.set({ zoom: 1, pan: null });
  }
  private zoomBy(dir: 1 | -1): void {
    const { box } = this.state;
    const next = stepZoom(this.state.zoom, dir, undefined, MIN_ZOOM, this.maxZoom());
    if (next === this.state.zoom || !box) return;
    this.applyZoom(next, { x: box.w / 2, y: box.h / 2 });
  }
  zoomIn(): void {
    this.zoomBy(1);
  }
  zoomOut(): void {
    this.zoomBy(-1);
  }
  /** 100% of the image's own pixels. */
  actual(): void {
    const fit = this.fit();
    const box = this.state.box;
    if (!box) return;
    this.applyZoom(1 / fit, { x: box.w / 2, y: box.h / 2 }, true);
  }
  private applyZoom(zoom: number, at: { x: number; y: number }, free = false): void {
    const fit = this.fit();
    const o = this.origin();
    const cur = this.scale();
    const { min, max } = this.limits();
    const target = free ? zoom : this.clamp(zoom);
    const next = zoomAt({ zoom: cur, x: o.x, y: o.y }, at, (target * fit) / cur, Math.min(min, target * fit), Math.max(max, target * fit));
    this.set({ zoom: target, pan: { x: next.x, y: next.y } });
  }
  /** From PanZoom: absolute scale and position. */
  onZoom = (next: PanZoomState): void => {
    const fit = this.fit();
    this.set({ zoom: this.clamp(next.zoom / fit), pan: { x: next.x, y: next.y } });
  };
  /** From PanZoom's 0 key: the same as the Fit button. */
  onReset = (): void => this.reset();
  onPan = (x: number, y: number): void => this.set({ pan: { x, y } });
}
