import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { CSSProperties, JSX, KeyboardEvent } from "react";
import { Button, IconButton, Spinner, ZoomBar } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { zoomLabels } from "./ImageView";
import { LoadError } from "./LoadError";
import { PdfFindBar } from "./PdfFindBar";
import { type PdfEngine, type PdfRender, pdfjsEngine } from "./pdfEngine";
import { CSS_PER_PT, locateMatch, pageAtScroll, pageOffsets, pagesToRender, parsePageInput } from "./pdfModel";
import { PAGE_PADDING, PdfSession, type PdfState } from "./pdfSession";
import { clearHighlights, highlightMatches } from "./previewFind";
import { formatBytes } from "./viewer";

/** Space between pages, in CSS px (`--x-space-2`). */
const GAP = PAGE_PADDING;

/** Mod+F: opens find. Alt is left alone so AltGr layouts keep their characters. */
export function isFindKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">): boolean {
  return (e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "f";
}

function layout(state: PdfState): { heights: number[]; offsets: number[] } {
  const heights = state.sizes.map((s) => s.h * CSS_PER_PT * state.scale);
  return { heights, offsets: pageOffsets(heights, GAP).map((o) => o + GAP) };
}

interface ToolbarProps {
  rel: string;
  state: PdfState;
  session: PdfSession;
  onFind: () => void;
  onOpenDefault: () => void;
}

/** File name and size, page controls, zoom, find and the default app. */
export function PdfToolbar(props: ToolbarProps): JSX.Element {
  const { rel, state, session, onFind, onOpenDefault } = props;
  const { t } = useI18n();
  const name = rel.split("/").pop() ?? rel;
  const commit = (el: HTMLInputElement): void => {
    const page = parsePageInput(el.value, state.pages);
    const now = session.get().page;
    if (page === null || page === now) el.value = String(now);
    else session.setPage(page);
  };
  return (
    <div className="media-bar">
      <span className="media-name" title={rel}>
        {name}
      </span>
      <span className="media-meta">{formatBytes(state.bytes)}</span>
      <span className="media-meta">{t("files.pdf.pages", { n: state.pages })}</span>
      <div className="pdf-pages-nav">
        <IconButton icon="chevron-left" label={t("files.pdf.prevPage")} disabled={state.page <= 1} onClick={() => session.setPage(state.page - 1)} />
        <input
          key={state.page}
          className="pdf-page-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={state.pages}
          aria-label={t("files.pdf.page")}
          defaultValue={state.page}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit(e.currentTarget);
            }
          }}
          onBlur={(e) => commit(e.currentTarget)}
        />
        <span>{t("files.pdf.pageTotal", { m: state.pages })}</span>
        <IconButton icon="chevron-right" label={t("files.pdf.nextPage")} disabled={state.page >= state.pages} onClick={() => session.setPage(state.page + 1)} />
      </div>
      <ZoomBar
        zoom={Math.round(state.scale * 100)}
        onZoomOut={() => session.zoomOut()}
        onFit={() => session.fit()}
        onZoomIn={() => session.zoomIn()}
        onActual={() => session.actual()}
        labels={zoomLabels(t, "files.zoom.fitWidth")}
      />
      <IconButton icon="search" label={t("files.pdf.find")} onClick={onFind} />
      <Button type="button" variant="secondary" onClick={onOpenDefault}>
        {t("files.openDefault")}
      </Button>
    </div>
  );
}

interface Entry {
  render: PdfRender;
  scale: number;
  done: boolean;
}

/** The page boxes. Only the pages near the view get a canvas and a text layer. */
export function PdfPages(props: { session: PdfSession; state: PdfState }): JSX.Element {
  const { session, state } = props;
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const entries = useRef(new Map<number, Entry>());
  const anchor = useRef<{ page: number; frac: number } | null>(null);
  const [failed, setFailed] = useState<ReadonlySet<number>>(new Set());
  const [tick, setTick] = useState(0);
  const { find } = state;

  const pageBox = (p: number): HTMLElement | null => host.current?.querySelector<HTMLElement>(`.pdf-page[data-page="${p}"]`) ?? null;
  const drop = (p: number): void => {
    const entry = entries.current.get(p);
    entry?.render.cancel();
    entries.current.delete(p);
    const box = pageBox(p);
    const canvas = box?.querySelector("canvas");
    if (canvas) canvas.width = 0;
    box?.querySelector(".pdf-text-layer")?.replaceChildren();
  };
  const start = (p: number): void => {
    const doc = session.document();
    const box = pageBox(p);
    const canvas = box?.querySelector("canvas");
    const layer = box?.querySelector<HTMLElement>(".pdf-text-layer");
    if (!doc || !canvas || !layer) return;
    layer.replaceChildren();
    const entry: Entry = { render: doc.render(p, canvas, layer, session.get().scale, window.devicePixelRatio || 1), scale: session.get().scale, done: false };
    entries.current.set(p, entry);
    setFailed((f) => (f.has(p) ? new Set([...f].filter((x) => x !== p)) : f));
    entry.render.done.then(
      () => {
        if (entries.current.get(p) !== entry) return;
        entry.done = true;
        setTick((n) => n + 1);
      },
      () => {
        if (entries.current.get(p) === entry) setFailed((f) => new Set([...f, p]));
      },
    );
  };
  const sync = (): void => {
    const el = host.current;
    const now = session.get();
    if (!el || !session.document() || now.status !== "ready") return;
    const { heights, offsets } = layout(now);
    const want = new Set(pagesToRender(offsets, heights, el.scrollTop, el.clientHeight).map((i) => i + 1));
    for (const [p, entry] of [...entries.current]) if (!want.has(p) || entry.scale !== now.scale) drop(p);
    for (const p of want) if (!entries.current.has(p)) start(p);
  };
  const follow = (): void => {
    const el = host.current;
    if (!el) return;
    const now = session.get();
    const { heights, offsets } = layout(now);
    const top = pageAtScroll(offsets, el.scrollTop + 1);
    anchor.current = el.scrollTop === 0 || !heights[top] ? null : { page: top, frac: Math.max(0, (el.scrollTop - offsets[top]) / heights[top]) };
    session.scrolled(pageAtScroll(offsets, el.scrollTop + el.clientHeight / 3) + 1);
    sync();
  };

  // The width of the box drives fit mode.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const measure = (): void => session.setBox(el.clientWidth);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [session]);

  // After a zoom the page that was on top stays on top.
  useLayoutEffect(() => {
    const el = host.current;
    if (!el) return;
    const a = anchor.current;
    const { heights, offsets } = layout(session.get());
    el.scrollTop = a && heights[a.page] ? offsets[a.page] + a.frac * heights[a.page] : 0;
    sync();
  }, [state.scale, state.sizes]);

  // A page asked for by the toolbar or by find.
  useEffect(() => {
    const el = host.current;
    if (!el || state.jump === 0) return;
    const { offsets } = layout(session.get());
    el.scrollTop = Math.max(0, (offsets[state.page - 1] ?? GAP) - GAP);
    follow();
  }, [state.jump]);

  useEffect(() => {
    const open = entries.current;
    return () => {
      for (const entry of open.values()) entry.render.cancel();
      open.clear();
    };
  }, [session]);

  // The matches of the current page are tinted once its text layer is there.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    clearHighlights(el);
    const at = locateMatch(find.matches, find.current);
    if (!at || !find.query || !entries.current.get(at.page + 1)?.done) return;
    const layer = pageBox(at.page + 1)?.querySelector<HTMLElement>(".pdf-text-layer");
    if (layer) highlightMatches(layer, find.query, at.nth);
  }, [find.matches, find.current, find.query, tick]);
  useEffect(() => () => clearHighlights(host.current), []);

  return (
    <div className="pdf-pages" ref={host} onScroll={follow}>
      {state.sizes.map((s, i) => {
        const style = {
          width: s.w * CSS_PER_PT * state.scale,
          height: s.h * CSS_PER_PT * state.scale,
          "--total-scale-factor": state.scale * CSS_PER_PT,
          "--scale-round-x": "1px",
          "--scale-round-y": "1px",
        } as CSSProperties;
        return (
          <div key={i} className="pdf-page" data-page={i + 1} style={style}>
            <canvas />
            <div className="pdf-text-layer" />
            {failed.has(i + 1) && <p className="pdf-page-error">{t("files.pdf.failed")}</p>}
          </div>
        );
      })}
    </div>
  );
}

const NOTES: Record<string, string> = {
  password: "files.pdf.password",
  invalid: "files.pdf.invalid",
  engine: "files.pdf.failed",
};

/** One PDF file: pages with a text layer, page and zoom controls, and find through the whole document. */
export function PdfView(props: { api: Api; worktree: string; rel: string; engine?: PdfEngine; session?: PdfSession }): JSX.Element {
  const { api, worktree, rel, engine = pdfjsEngine } = props;
  const { t } = useI18n();
  const session = useMemo(() => props.session ?? new PdfSession(api, engine, worktree, rel), [props.session, api, engine, worktree, rel]);
  const state = useSyncExternalStore(session.subscribe, session.get, session.get);
  const [finding, setFinding] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);

  const openDefault = (): void =>
    void api.fileOpenDefault(worktree, rel).catch(() => pushToast({ id: "open-default", text: t("files.openDefault.failed") }));
  const openButton = (
    <Button type="button" variant="secondary" onClick={openDefault}>
      {t("files.openDefault")}
    </Button>
  );

  if (state.status === "error") {
    const code = state.error ?? "io";
    if (code === "too_large") {
      return (
        <div className="file-note">
          <p className="ws-empty">{t("error.too_large")}</p>
          <p className="file-note-body">{t("files.pdf.tooLarge.body")}</p>
          {openButton}
        </div>
      );
    }
    if (code in NOTES) {
      return (
        <div className="file-note">
          <p className="ws-empty">{t(NOTES[code])}</p>
          {openButton}
        </div>
      );
    }
    return <LoadError code={code} onRetry={() => void session.load()} onReveal={() => void api.fileReveal(worktree, rel).catch(() => undefined)} />;
  }

  const openFind = (): void => {
    if (finding) root.current?.querySelector<HTMLInputElement>(".md-find input")?.focus();
    else setFinding(true);
  };
  const closeFind = (): void => {
    setFinding(false);
    void session.search("");
    root.current?.focus();
  };
  const onKeyDown = (e: KeyboardEvent<HTMLElement>): void => {
    if (!isFindKey(e)) return;
    e.preventDefault();
    openFind();
  };

  if (state.status === "loading") {
    const name = rel.split("/").pop() ?? rel;
    return (
      <div className="media-view pdf-view" role="region" aria-label={t("files.pdf.label")} tabIndex={-1}>
        <div className="media-bar">
          <span className="media-name" title={rel}>
            {name}
          </span>
          {openButton}
        </div>
        <p className="ws-empty">
          <Spinner label={t("files.pdf.loading")} /> <span aria-hidden="true">{t("files.pdf.loading")}</span>
        </p>
      </div>
    );
  }

  const { find } = state;
  return (
    <div className="media-view pdf-view" role="region" aria-label={t("files.pdf.label")} tabIndex={-1} ref={root} onKeyDown={onKeyDown}>
      <PdfToolbar rel={rel} state={state} session={session} onFind={openFind} onOpenDefault={openDefault} />
      {finding && (
        <PdfFindBar
          query={find.query}
          count={find.total}
          current={find.current}
          searching={find.searching ? { n: find.scanned, m: state.pages } : null}
          onQuery={(q) => void session.search(q)}
          onStep={(dir) => session.step(dir)}
          onClose={closeFind}
        />
      )}
      <PdfPages session={session} state={state} />
    </div>
  );
}
