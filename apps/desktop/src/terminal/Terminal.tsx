import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PtyInfo, type PtyProfile } from "../api";
import { useI18n } from "../i18n";
import { PtyClient } from "./ptyClient";

/**
 * One running pty in an xterm. Starts on mount. Kills the pty on unmount, unless the pty
 * belongs to a `client` passed in: that one lives on with its owner.
 */
export function Terminal(props: {
  api: Api;
  id: string;
  /** The tab's own client; without one the view makes and owns a client for `id`. */
  client?: PtyClient;
  cwd: string;
  profile: PtyProfile;
  onStarted(info: PtyInfo): void;
  onError(error: ApiError): void;
  /** Bytes of pty output, as they arrive. */
  onOutput?(bytes: number): void;
  /** The user typed into the terminal. */
  onInput?(): void;
}): JSX.Element {
  const { t } = useI18n();
  const host = useRef<HTMLDivElement>(null);
  const search = useRef<SearchAddon | null>(null);
  const [finding, setFinding] = useState(false);
  const [query, setQuery] = useState("");
  // Callbacks change every render; the effect below runs once per pty.
  const handlers = useRef(props);
  handlers.current = props;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const css = getComputedStyle(el);
    const color = (name: string) => css.getPropertyValue(name).trim() || undefined;
    const term = new XTerm({
      cursorBlink: true,
      fontFamily: color("--x-font-mono"),
      fontSize: 13,
      scrollback: 10_000,
      theme: { background: color("--x-color-surface"), foreground: color("--x-color-ink") },
    });
    const fit = new FitAddon();
    const finder = new SearchAddon();
    search.current = finder;
    term.loadAddon(fit);
    term.loadAddon(finder);
    // No opener plugin in the app: the webview hands the link to the system browser.
    term.loadAddon(new WebLinksAddon((_event, uri) => window.open(uri, "_blank", "noopener")));
    term.open(el);
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === "f") {
        setFinding(true);
        return false;
      }
      return true;
    });
    term.onSelectionChange(() => {
      const text = term.getSelection();
      if (text) void navigator.clipboard?.writeText(text).catch(() => {});
    });

    // A hidden view has no size; fitting it would shrink the pty to nothing.
    const fitVisible = () => {
      if (el.clientWidth > 0 && el.clientHeight > 0) fit.fit();
    };
    fitVisible();

    const owned = !props.client;
    const client = props.client ?? new PtyClient(props.api, props.id);
    let alive = true;
    term.onData((text) => {
      handlers.current.onInput?.();
      void client.input(text).catch(() => {});
    });
    term.onResize(({ cols, rows }) => void client.resize(cols, rows).catch(() => {}));
    // A mount undone in the same tick (StrictMode in dev) starts nothing, so a shared client
    // is started once, by the mount that stays.
    void Promise.resolve().then(() => {
      if (!alive) return;
      client.start(props.cwd, props.profile, term.cols, term.rows, (bytes, rendered) => {
        handlers.current.onOutput?.(bytes.length);
        term.write(bytes, rendered);
      }).then(
        (info) => {
          if (!alive) return;
          handlers.current.onStarted(info);
          term.focus();
        },
        (e: unknown) => alive && handlers.current.onError(toApiError(e)),
      );
    });
    const observer = new ResizeObserver(fitVisible);
    observer.observe(el);

    return () => {
      alive = false;
      observer.disconnect();
      if (owned) void client.dispose();
      search.current = null;
      term.dispose();
    };
  }, [props.api, props.id, props.client, props.cwd, props.profile]);

  return (
    <div className="terminal-pane">
      {finding && (
        <input
          className="terminal-find"
          type="search"
          autoFocus
          aria-label={t("terminal.search")}
          placeholder={t("terminal.search")}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            search.current?.findNext(e.target.value, { incremental: true });
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (e.shiftKey) search.current?.findPrevious(query);
              else search.current?.findNext(query);
            }
            if (e.key === "Escape") setFinding(false);
          }}
        />
      )}
      <div ref={host} className="terminal-host" />
    </div>
  );
}
