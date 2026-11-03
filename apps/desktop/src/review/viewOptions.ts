export type ViewOptions = {
  layout: "inline" | "split";
  ignoreWhitespace: boolean;
  collapse: boolean;
  lineNumbers: boolean;
  wrap: boolean;
  listWidth: number;
};

export const VIEW_KEY = "xdev.review.view";
export const LIST_MIN = 160;
export const LIST_MAX = 480;
export const LIST_DEFAULT = 240;

export const DEFAULT_VIEW: ViewOptions = {
  layout: "inline",
  ignoreWhitespace: false,
  collapse: true,
  lineNumbers: true,
  wrap: false,
  listWidth: LIST_DEFAULT,
};

export function clampListWidth(px: number): number {
  if (!Number.isFinite(px)) return LIST_DEFAULT;
  return Math.min(LIST_MAX, Math.max(LIST_MIN, Math.round(px)));
}

type Reader = Pick<Storage, "getItem"> | null | undefined;
type Writer = Pick<Storage, "setItem"> | null | undefined;

/** Saved options; anything unknown or broken falls back to the defaults. */
export function readViewOptions(storage: Reader): ViewOptions {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(VIEW_KEY) ?? "null");
  } catch {
    raw = null;
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const flag = (k: "ignoreWhitespace" | "collapse" | "lineNumbers" | "wrap"): boolean => (typeof o[k] === "boolean" ? o[k] : DEFAULT_VIEW[k]);
  return {
    layout: o.layout === "split" ? "split" : "inline",
    ignoreWhitespace: flag("ignoreWhitespace"),
    collapse: flag("collapse"),
    lineNumbers: flag("lineNumbers"),
    wrap: flag("wrap"),
    listWidth: typeof o.listWidth === "number" ? clampListWidth(o.listWidth) : LIST_DEFAULT,
  };
}

export function writeViewOptions(storage: Writer, opts: ViewOptions): void {
  try {
    storage?.setItem(VIEW_KEY, JSON.stringify({ ...opts, listWidth: clampListWidth(opts.listWidth) }));
  } catch {
    // A full or blocked store only costs the saved choice.
  }
}
