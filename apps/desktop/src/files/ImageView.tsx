import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { JSX } from "react";
import { Dialog, PanZoom, ZoomBar } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { copyPng } from "./copyImage";
import { ImageSession } from "./imageSession";
import { LoadError } from "./LoadError";
import { formatBytes } from "./viewer";

type T = (key: string, vars?: Record<string, string | number>) => string;

export function zoomLabels(t: T, fit = "files.zoom.fit") {
  return { zoomOut: t("files.zoom.out"), zoomIn: t("files.zoom.in"), fit: t(fit), actual: t("files.zoom.actual"), group: t("files.zoom.group") };
}

/** An image inside a pan and zoom viewport; reports the viewport size so fit can be worked out. */
function Stage(props: { session: ImageSession; name: string; label: string; imgRef?: { current: HTMLImageElement | null } }): JSX.Element {
  const { session, name, label } = props;
  const state = useSyncExternalStore(session.subscribe, session.get);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = () => session.setBox(el.clientWidth, el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session]);
  const o = session.origin();
  const { min, max } = session.limits();
  return (
    <div className="image-stage" ref={host}>
      <PanZoom zoom={session.scale()} x={o.x} y={o.y} min={min} max={max} onZoom={session.onZoom} onPan={session.onPan} onReset={session.onReset} label={label}>
        {state.url && (
          <img
            ref={props.imgRef}
            src={state.url}
            alt={name}
            draggable={false}
            onLoad={(e) => session.setNatural(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
          />
        )}
      </PanZoom>
    </div>
  );
}

function Expanded(props: { session: ImageSession; name: string; onClose: () => void }): JSX.Element {
  const { t } = useI18n();
  const { session, name, onClose } = props;
  const view = useMemo(() => session.view(), [session]);
  useEffect(() => {
    view.attach();
    return () => view.dispose();
  }, [view]);
  useSyncExternalStore(view.subscribe, view.get);
  const img = useRef<HTMLImageElement | null>(null);
  const copy = async () => {
    const ok = img.current ? await copyPng(img.current) : false;
    pushToast({ id: "image-copy", text: t(ok ? "files.image.copied" : "files.image.copyFailed") });
  };
  return (
    <Dialog title={name} size="wide" body="plain" confirmLabel={t("files.image.copy")} cancelLabel={t("files.image.close")} onConfirm={() => void copy()} onCancel={onClose}>
      <ZoomBar
        zoom={view.percent()}
        onZoomOut={view.zoomOut}
        onFit={view.reset}
        onZoomIn={view.zoomIn}
        onActual={view.actual}
        labels={zoomLabels(t, "files.zoom.fitScreen")}
      />
      <Stage session={view} name={name} label={t("files.image.label")} imgRef={img} />
    </Dialog>
  );
}

/** One image file: bytes become an object URL, shown fitted, zoomable and copyable. */
export function ImageView(props: { api: Api; worktree: string; rel: string }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const session = useMemo(() => new ImageSession(api, worktree, rel), [api, worktree, rel]);
  const state = useSyncExternalStore(session.subscribe, session.get);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);
  const name = rel.split("/").pop() ?? rel;
  const reveal = () => void api.fileReveal(worktree, rel).catch(() => undefined);

  if (state.status === "error") {
    if (state.error === "too_large") {
      return (
        <div className="file-note">
          <p className="ws-empty">{t("error.too_large")}</p>
          <p className="file-note-body">{t("files.image.tooLarge.body")}</p>
          <button type="button" className="btn-secondary" onClick={reveal}>{t("files.menu.reveal")}</button>
        </div>
      );
    }
    return <LoadError code={state.error ?? "io"} onRetry={() => void session.load()} onReveal={reveal} />;
  }
  const openDefault = () =>
    void api.fileOpenDefault(worktree, rel).catch(() => pushToast({ id: "open-default", text: t("files.openDefault.failed") }));
  return (
    <div className="media-view image-view">
      <div className="media-bar">
        <ZoomBar zoom={session.percent()} onZoomOut={session.zoomOut} onFit={session.reset} onZoomIn={session.zoomIn} onActual={session.actual} labels={zoomLabels(t)} />
        <span className="media-name" title={rel}>{name}</span>
        {state.nat && <span className="media-meta">{t("files.image.dims", { w: state.nat.w, h: state.nat.h })}</span>}
        {state.status === "ready" && <span className="media-meta">{formatBytes(state.bytes)}</span>}
        <button type="button" className="btn-secondary" disabled={state.status !== "ready"} onClick={() => setExpanded(true)}>{t("files.image.expand")}</button>
        <button type="button" className="btn-secondary" onClick={openDefault}>{t("files.openDefault")}</button>
      </div>
      {state.status === "loading" ? <p className="ws-empty">{t("files.image.loading")}</p> : <Stage session={session} name={name} label={t("files.image.label")} />}
      {expanded && <Expanded session={session} name={name} onClose={() => setExpanded(false)} />}
    </div>
  );
}
