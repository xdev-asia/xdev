import { Button, EmptyState, IconButton } from "@xdev-asia/ui";
import { useEffect, useRef, useState, type FormEvent, type JSX } from "react";
import { toApiError, type Api, type BrowserBounds } from "@/api";
import { useI18n } from "@/i18n";
import { BLANK, notePage, openBrowserTab, type BrowserTabEntry } from "./browserTabs";
import { pageShown, useAppOverlay } from "./overlayWatch";

/** How often a shown page checks where its body is, for a move no resize reports (a canvas card dragged). */
const PLACE_CHECK_MS = 500;

type BrowserApi = Pick<
  Api,
  | "browserShow"
  | "browserSetBounds"
  | "browserHide"
  | "browserNavigate"
  | "browserHistory"
  | "browserReload"
  | "browserDevtools"
  | "onBrowserPage"
  | "onBrowserEvicted"
  | "onBrowserPopup"
  | "openUrl"
>;

/**
 * The factor from CSS pixels of the page to the window's logical pixels. The app zooms with CSS
 * `zoom` on the root; whether a rectangle already includes it is read off the root itself.
 */
export function zoomScale(viewport: number, rootWidth: number): number {
  if (!(viewport > 0) || !(rootWidth > 0)) return 1;
  const s = viewport / rootWidth;
  return s > 0.25 && s < 4 && Math.abs(s - 1) > 0.01 ? s : 1;
}

function boundsOf(el: HTMLElement): BrowserBounds {
  const r = el.getBoundingClientRect();
  const root = typeof document === "undefined" ? 0 : document.documentElement.getBoundingClientRect().width;
  const s = zoomScale(typeof window === "undefined" ? 0 : window.innerWidth, root);
  return { x: r.left * s, y: r.top * s, width: r.width * s, height: r.height * s };
}

const sameBounds = (a: BrowserBounds | null, b: BrowserBounds) =>
  !!a && Math.round(a.x) === Math.round(b.x) && Math.round(a.y) === Math.round(b.y) && Math.round(a.width) === Math.round(b.width) && Math.round(a.height) === Math.round(b.height);

export interface BrowserTabProps {
  api: BrowserApi;
  entry: BrowserTabEntry;
  /** The tab is the front tab of a pane that is on screen. */
  visible: boolean;
}

/** A browser tab: the toolbar, and the body the page's webview is placed over. */
export function BrowserTab({ api, entry, visible }: BrowserTabProps): JSX.Element {
  const { t } = useI18n();
  const id = entry.id;
  const overlay = useAppOverlay();
  const body = useRef<HTMLDivElement | null>(null);
  const showing = useRef(false);
  const placedAt = useRef<BrowserBounds | null>(null);
  const url = useRef(entry.url);
  url.current = entry.url;
  const [unavailable, setUnavailable] = useState(false);
  const [evicted, setEvicted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;

  // The page's own news: where it is, its title, whether it loads; a new window opens as a new tab.
  useEffect(() => {
    const offs = [
      api.onBrowserPage((e) => e.tab === id && notePage(id, e)),
      api.onBrowserEvicted((e) => {
        if (e.tab !== id) return;
        showing.current = false;
        placedAt.current = null;
        notePage(id, { url: e.url });
        if (visibleRef.current) setEvicted(true);
      }),
      api.onBrowserPopup((e) => e.tab === id && openBrowserTab(entry.worktree, { url: e.url })),
    ];
    return () => offs.forEach((p) => void p.then((off) => off()).catch(() => {}));
  }, [api, id, entry.worktree]);

  // Shown while the tab is on screen, no overlay is open and the body has room; hidden otherwise.
  useEffect(() => {
    const el = body.current;
    const hide = () => {
      if (!showing.current) return;
      showing.current = false;
      placedAt.current = null;
      void api.browserHide(id).catch(() => {});
    };
    const place = () => {
      if (!el) return;
      const b = boundsOf(el);
      if (unavailable || evicted || !pageShown({ visible, overlay, width: b.width, height: b.height })) return hide();
      if (showing.current && sameBounds(placedAt.current, b)) return;
      const first = !showing.current;
      showing.current = true;
      placedAt.current = b;
      (first ? api.browserShow(id, url.current, b) : api.browserSetBounds(id, b)).catch((e: unknown) => {
        showing.current = false;
        placedAt.current = null;
        if (toApiError(e).code === "browser_unavailable") setUnavailable(true);
      });
    };
    place();
    if (!el || !visible || overlay) return;
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(el);
    window.addEventListener("resize", place);
    const timer = window.setInterval(place, PLACE_CHECK_MS);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", place);
      window.clearInterval(timer);
    };
  }, [api, id, visible, overlay, unavailable, evicted]);

  // Off screen for good: the page waits hidden; closing the tab closes it (`browserClose`).
  useEffect(
    () => () => {
      if (showing.current) void api.browserHide(id).catch(() => {});
      showing.current = false;
    },
    [api, id],
  );

  // A link sent to the tab loads in it.
  const nav = useRef(entry.nav);
  useEffect(() => {
    if (entry.nav === nav.current) return;
    nav.current = entry.nav;
    setEvicted(false);
    void api.browserNavigate(id, entry.url).catch(() => {});
  }, [api, id, entry.nav, entry.url]);

  async function go(e: FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    const text = draft ?? "";
    try {
      const next = await api.browserNavigate(id, text);
      notePage(id, { url: next });
      setError(null);
      setDraft(null);
      setEvicted(false);
    } catch (err) {
      setError(t(`error.${toApiError(err).code}`));
    }
  }

  const shownUrl = entry.url === BLANK ? "" : entry.url;
  const external = shownUrl !== "" && /^https?:\/\//i.test(shownUrl);
  const openSystem = () => external && void api.openUrl(entry.url).catch(() => {});
  const paused = visible && overlay && !unavailable && !evicted;

  return (
    <div className="browser-tab" data-loading={entry.loading ? "" : undefined}>
      <div className="browser-bar" role="toolbar" aria-label={t("browser.toolbar")}>
        <IconButton icon="arrow-left" label={t("browser.back")} disabled={unavailable} onClick={() => void api.browserHistory(id, -1).catch(() => {})} />
        <IconButton icon="arrow-right" label={t("browser.forward")} disabled={unavailable} onClick={() => void api.browserHistory(id, 1).catch(() => {})} />
        <IconButton icon="refresh" label={t("browser.reload")} disabled={unavailable} onClick={(e) => void api.browserReload(id, e.shiftKey).catch(() => {})} />
        <form className="browser-address" onSubmit={(e) => void go(e)}>
          <input
            type="text"
            name="address"
            aria-label={t("browser.address")}
            placeholder={t("browser.addressPlaceholder")}
            spellCheck={false}
            autoComplete="off"
            value={draft ?? shownUrl}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            aria-busy={entry.loading || undefined}
            onFocus={(e) => {
              setDraft(e.currentTarget.value);
              e.currentTarget.select();
            }}
            onChange={(e) => {
              setDraft(e.target.value);
              setError(null);
            }}
            onBlur={() => !error && setDraft(null)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              setDraft(null);
              setError(null);
              e.currentTarget.blur();
            }}
          />
        </form>
        <IconButton icon="external" label={t("browser.openSystem")} disabled={!external} onClick={openSystem} />
        <IconButton icon="code" label={t("browser.devtools")} disabled={unavailable} onClick={() => void api.browserDevtools(id).catch(() => {})} />
      </div>
      {error && (
        <p className="browser-error error-text" id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
      <div className="browser-page" ref={body} data-tab={id}>
        {unavailable ? (
          <EmptyState
            size="center"
            icon="globe"
            title={t("browser.unavailable.title")}
            hint={t("browser.unavailable.hint")}
            actions={
              <Button type="button" variant="primary" disabled={!external} onClick={openSystem}>
                {t("browser.openSystem")}
              </Button>
            }
          />
        ) : evicted ? (
          <EmptyState
            title={t("browser.evicted.title")}
            hint={t("browser.evicted.hint")}
            actions={
              <Button type="button" variant="primary" onClick={() => setEvicted(false)}>
                {t("browser.evicted.load")}
              </Button>
            }
          />
        ) : paused ? (
          <p className="browser-paused" role="status">
            {t("browser.paused")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
