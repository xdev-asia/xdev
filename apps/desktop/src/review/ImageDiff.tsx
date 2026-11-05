import { useEffect, useState } from "react";
import type { CSSProperties, JSX } from "react";
import { toApiError, type Api, type ReviewFile } from "@/api";
import { formatBytes, mimeOf } from "@/files/viewer";
import { useI18n } from "@/i18n";
import { effectiveKind, modesFor, onionOpacity, swipeClip, type ImageMode } from "./imageDiff";

export type Side =
  | { status: "none" }
  | { status: "loading" }
  | { status: "ready"; url: string; bytes: number }
  | { status: "too_large" }
  | { status: "error"; code: string };

export type Size = { w: number; h: number };

/** One side's bytes as an object URL; `not_found` means the side is not there. */
async function load(read: () => Promise<Uint8Array>, path: string): Promise<Side> {
  try {
    const bytes = await read();
    return { status: "ready", url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeOf(path) })), bytes: bytes.length };
  } catch (e) {
    const code = toApiError(e).code;
    if (code === "not_found") return { status: "none" };
    return code === "too_large" ? { status: "too_large" } : { status: "error", code };
  }
}

/**
 * A changed image as images: the old and the new side by side, a swipe slider, or an onion skin
 * (the new one over the old at a chosen opacity). An added or deleted image shows its one side
 * with a label. `base` is the commit the old side is read at, `null` for HEAD.
 */
export function ImageDiff(props: { api: Api; worktree: string; path: string; kind: ReviewFile["kind"]; base: string | null; rev?: number }): JSX.Element {
  const { api, worktree, path, kind, base, rev = 0 } = props;
  const { t } = useI18n();
  const [before, setBefore] = useState<Side>({ status: "loading" });
  const [after, setAfter] = useState<Side>({ status: "loading" });
  const [sizes, setSizes] = useState<{ old?: Size; new?: Size }>({});
  const [mode, setMode] = useState<ImageMode>("side");
  const [swipe, setSwipe] = useState(50);
  const [onion, setOnion] = useState(50);
  const name = path.split("/").pop() ?? path;

  useEffect(() => {
    let live = true;
    const urls: string[] = [];
    setBefore(kind === "added" ? { status: "none" } : { status: "loading" });
    setAfter(kind === "deleted" ? { status: "none" } : { status: "loading" });
    setSizes({});
    // A side that arrives after the view moved on gives its URL back at once.
    const take = (side: Side, set: (s: Side) => void): void => {
      if (side.status === "ready") {
        if (live) urls.push(side.url);
        else URL.revokeObjectURL(side.url);
      }
      if (live) set(side);
    };
    if (kind !== "added") void load(() => api.worktreeFileHeadBytes(worktree, path, base), path).then((s) => take(s, setBefore));
    if (kind !== "deleted") void load(() => api.fileBytes(worktree, path), path).then((s) => take(s, setAfter));
    return () => {
      live = false;
      urls.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [api, worktree, path, kind, base, rev]);

  const props2: ViewProps = { name, kind, before, after, sizes, mode, swipe, onion, onMode: setMode, onSwipe: setSwipe, onOnion: setOnion, onSize: (key, size) => setSizes((s) => (s[key]?.w === size.w && s[key]?.h === size.h ? s : { ...s, [key]: size })) };
  return <ImageDiffView {...props2} />;
}

export type ViewProps = {
  name: string;
  kind: ReviewFile["kind"];
  before: Side;
  after: Side;
  sizes: { old?: Size; new?: Size };
  mode: ImageMode;
  swipe: number;
  onion: number;
  onMode(mode: ImageMode): void;
  onSwipe(pos: number): void;
  onOnion(pos: number): void;
  onSize(side: "old" | "new", size: Size): void;
};

/** What the images look like once both sides are known: no state of its own. */
export function ImageDiffView(props: ViewProps): JSX.Element {
  const { name, kind, before, after, sizes, mode, swipe, onion } = props;
  const { t } = useI18n();

  const loading = before.status === "loading" || after.status === "loading";
  const shownKind = effectiveKind(kind, before.status === "none", after.status === "none");
  const modes = modesFor(shownKind);
  const active = modes.includes(mode) ? mode : "side";
  const sides: { key: "old" | "new"; side: Side }[] = [
    { key: "old", side: before },
    { key: "new", side: after },
  ];
  const bad = sides.find(({ side }) => side.status === "too_large" || side.status === "error");

  const caption = (key: "old" | "new", side: Side): JSX.Element => {
    const size = sizes[key];
    const label = shownKind === "added" && key === "new" ? t("review.image.added") : shownKind === "deleted" && key === "old" ? t("review.image.deleted") : t(`review.image.${key}`);
    return (
      <figcaption className="rv-image-caption">
        <span className="rv-image-label">{label}</span>
        {size && <span className="rv-image-meta">{t("files.image.dims", { w: size.w, h: size.h })}</span>}
        {side.status === "ready" && <span className="rv-image-meta">{t("review.image.size", { size: formatBytes(side.bytes) })}</span>}
      </figcaption>
    );
  };
  const img = (key: "old" | "new", side: Side, style?: CSSProperties) =>
    side.status === "ready" ? (
      <img
        className="rv-image-img"
        data-side={key}
        src={side.url}
        alt={t(key === "old" ? "review.image.oldAlt" : "review.image.newAlt", { name })}
        style={style}
        draggable={false}
        onLoad={(e) => props.onSize(key, { w: e.currentTarget.naturalWidth, h: e.currentTarget.naturalHeight })}
      />
    ) : null;

  if (loading) return <p className="ws-empty" role="status">{t("review.image.loading")}</p>;
  if (bad) {
    return (
      <p className="ws-empty">
        {bad.side.status === "too_large" ? t("review.image.tooLarge") : t("review.image.error", { error: t(`error.${(bad.side as { code: string }).code}`) })}
      </p>
    );
  }
  const stacked = active !== "side" && before.status === "ready" && after.status === "ready";
  return (
    <div className="rv-image" data-mode={active} data-kind={shownKind}>
      {modes.length > 1 && (
        <div className="rv-layout" role="group" aria-label={t("review.image.group")}>
          {modes.map((m) => (
            <button key={m} type="button" data-mode={m} aria-pressed={active === m} onClick={() => props.onMode(m)}>
              {t(`review.image.mode.${m === "side" ? "sideBySide" : m}`)}
            </button>
          ))}
        </div>
      )}
      {stacked ? (
        <>
          <div className="rv-image-stack">
            {img("old", before)}
            {img("new", after, active === "swipe" ? { clipPath: swipeClip(swipe) } : { opacity: onionOpacity(onion) })}
          </div>
          <label className="rv-image-slider">
            <span>{t(active === "swipe" ? "review.image.swipe" : "review.image.opacity")}</span>
            <input
              type="range"
              min={0}
              max={100}
              step={1}
              value={active === "swipe" ? swipe : onion}
              aria-valuetext={`${active === "swipe" ? swipe : onion}%`}
              onChange={(e) => (active === "swipe" ? props.onSwipe : props.onOnion)(Number(e.target.value))}
            />
          </label>
          <div className="rv-image-captions">
            {sides.map(({ key, side }) => (
              <figure key={key} className="rv-image-fig">
                {caption(key, side)}
              </figure>
            ))}
          </div>
        </>
      ) : (
        <div className="rv-image-sides">
          {sides.map(({ key, side }) =>
            side.status === "ready" ? (
              <figure key={key} className="rv-image-fig">
                {caption(key, side)}
                {img(key, side)}
              </figure>
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}
