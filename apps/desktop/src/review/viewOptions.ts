import type { DiffSettings } from "@/api";
import { DIFF_DEFAULTS } from "@/settings/generalDefaults";

export type ViewOptions = {
  layout: "inline" | "split";
  ignoreWhitespace: boolean;
  collapse: boolean;
  lineNumbers: boolean;
  wrap: boolean;
  /** The file list is a folder tree. */
  tree: boolean;
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
  tree: false,
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
  const flag = (k: "ignoreWhitespace" | "collapse" | "lineNumbers" | "wrap" | "tree"): boolean => (typeof o[k] === "boolean" ? o[k] : DEFAULT_VIEW[k]);
  return {
    layout: o.layout === "split" ? "split" : "inline",
    ignoreWhitespace: flag("ignoreWhitespace"),
    collapse: flag("collapse"),
    lineNumbers: flag("lineNumbers"),
    wrap: flag("wrap"),
    tree: flag("tree"),
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

/** What a review view keeps for itself: the settings carry the rest. */
export type LocalView = Pick<ViewOptions, "lineNumbers" | "listWidth">;

export const LOCAL_KEY = "xdev.review.local";
const LOCAL_DEFAULT: LocalView = { lineNumbers: DEFAULT_VIEW.lineNumbers, listWidth: LIST_DEFAULT };

/** The options a view starts with: the diff settings, plus what the view keeps for itself. */
export function fromDiffSettings(d: DiffSettings, local: LocalView = LOCAL_DEFAULT): ViewOptions {
  return {
    layout: d.defaultView,
    ignoreWhitespace: d.ignoreWhitespace,
    collapse: d.collapseUnchanged,
    wrap: d.wordWrap,
    tree: d.fileTree,
    lineNumbers: local.lineNumbers,
    listWidth: clampListWidth(local.listWidth),
  };
}

/** The diff settings that "Save as default" stores for `o`; `fileTree` is the tree toggle. */
export function toDiffSettings(o: ViewOptions, base: DiffSettings): DiffSettings {
  return { ...base, defaultView: o.layout, ignoreWhitespace: o.ignoreWhitespace, collapseUnchanged: o.collapse, wordWrap: o.wrap, fileTree: o.tree };
}

export function readLocalView(storage: Reader): LocalView {
  let raw: unknown;
  try {
    raw = JSON.parse(storage?.getItem(LOCAL_KEY) ?? "null");
  } catch {
    raw = null;
  }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  return {
    lineNumbers: typeof o.lineNumbers === "boolean" ? o.lineNumbers : LOCAL_DEFAULT.lineNumbers,
    listWidth: typeof o.listWidth === "number" ? clampListWidth(o.listWidth) : LOCAL_DEFAULT.listWidth,
  };
}

export function writeLocalView(storage: Writer, local: LocalView): void {
  try {
    storage?.setItem(LOCAL_KEY, JSON.stringify({ lineNumbers: local.lineNumbers, listWidth: clampListWidth(local.listWidth) }));
  } catch {
    // A full or blocked store only costs the saved choice.
  }
}

const same = (a: DiffSettings, b: DiffSettings) => (Object.keys(a) as (keyof DiffSettings)[]).every((k) => a[k] === b[k]);

/**
 * One time: the options an older version kept in `localStorage` become the diff settings, when the
 * settings are still the defaults; then the old key goes. Returns the settings now in force.
 * The key stays when the write fails, so the next view tries again.
 */
export async function migrateViewOptions(
  storage: (Reader & Writer & Partial<Pick<Storage, "removeItem">>) | null | undefined,
  stored: DiffSettings,
  put: (next: DiffSettings) => Promise<DiffSettings>,
): Promise<DiffSettings> {
  let legacy: string | null = null;
  try {
    legacy = storage?.getItem(VIEW_KEY) ?? null;
  } catch {
    legacy = null;
  }
  if (legacy === null) return stored;
  const old = readViewOptions(storage);
  let now = stored;
  if (same(stored, DIFF_DEFAULTS)) {
    try {
      now = await put(toDiffSettings(old, stored));
    } catch {
      return stored;
    }
  }
  writeLocalView(storage, old);
  try {
    storage?.removeItem?.(VIEW_KEY);
  } catch {
    // The key is read again next time and dropped then.
  }
  return now;
}
