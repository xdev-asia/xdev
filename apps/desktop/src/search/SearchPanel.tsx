import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type FileHits, type SearchEvent } from "@/api";
import { useI18n } from "@/i18n";
import { fileName } from "@/files/fileTabs";
import { applyEvent, hitColumn, IDLE, STARTED, toQuery, unitRanges, type SearchForm, type SearchResult } from "./searchState";
import "./search.css";

/** Typing stops this long before a search starts. */
export const SEARCH_DEBOUNCE_MS = 300;
/** Mirrors `HIT_MAX` in Rust. */
const HIT_MAX = "5 000";

export interface SearchPanelProps {
  api: Api;
  /** The worktree on screen; null when there is none. */
  worktree: string | null;
  /** A new value puts the keyboard in the query box. */
  focusSeq: number;
  onOpen(rel: string, at: { line: number; column?: number }): void;
}

let runSeq = 0;

function Line(props: { text: string; ranges: [number, number][] }): JSX.Element {
  const { text } = props;
  const parts: JSX.Element[] = [];
  let at = 0;
  for (const [s, e] of unitRanges(text, props.ranges)) {
    if (s > at) parts.push(<span key={`t${at}`}>{text.slice(at, s)}</span>);
    parts.push(
      <mark key={`h${s}`} className="sr-hit">
        {text.slice(s, e)}
      </mark>,
    );
    at = e;
  }
  if (at < text.length) parts.push(<span key={`t${at}`}>{text.slice(at)}</span>);
  return <>{parts}</>;
}

/** Search in files: a query, three switches, two glob fields and the results grouped by file. */
export function SearchPanel(props: SearchPanelProps): JSX.Element {
  const { api, worktree, focusSeq, onOpen } = props;
  const { t } = useI18n();
  const [form, setForm] = useState<SearchForm>({ text: "", caseSensitive: false, wholeWord: false, regex: false, include: "", exclude: "" });
  const [details, setDetails] = useState(false);
  const [result, setResult] = useState<SearchResult>(IDLE);
  const [folded, setFolded] = useState<Set<string>>(new Set());
  // The id of the search whose events count; an older one that still talks is dropped.
  const current = useRef<string | null>(null);
  const input = useRef<HTMLInputElement | null>(null);

  function stop(): void {
    const id = current.current;
    current.current = null;
    if (id) void api.filesSearchCancel(id).catch(() => undefined);
  }

  useEffect(() => {
    if (focusSeq > 0) {
      input.current?.focus();
      input.current?.select();
    }
  }, [focusSeq]);

  useEffect(() => {
    stop();
    if (!worktree || form.text === "") {
      setResult(IDLE);
      return;
    }
    const timer = setTimeout(() => {
      stop();
      const id = `files-search-${++runSeq}`;
      current.current = id;
      setResult(STARTED);
      setFolded(new Set());
      const onEvent = (e: SearchEvent) => {
        if (current.current !== id) return;
        setResult((r) => applyEvent(r, e));
      };
      api.filesSearch(worktree, toQuery(form), id, onEvent).catch((e: unknown) => {
        if (current.current !== id) return;
        setResult((r) => ({ ...r, phase: "error", message: toApiError(e).code }));
      });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [worktree, form]);

  // A search still running when the panel goes away stops.
  useEffect(() => stop, []);

  const set = (patch: Partial<SearchForm>) => setForm((f) => ({ ...f, ...patch }));
  const toggle = (key: "caseSensitive" | "wholeWord" | "regex", label: string, text: string): JSX.Element => (
    <button type="button" className="sr-toggle" aria-pressed={form[key]} aria-label={t(label)} title={t(label)} onClick={() => set({ [key]: !form[key] })}>
      {text}
    </button>
  );

  function flip(rel: string): void {
    setFolded((s) => {
      const next = new Set(s);
      if (!next.delete(rel)) next.add(rel);
      return next;
    });
  }

  function openHit(file: FileHits, i: number): void {
    const hit = file.hits[i];
    onOpen(file.rel, { line: hit.line, column: hitColumn(hit.text, hit.ranges) });
  }

  function clear(): void {
    stop();
    set({ text: "" });
    setResult(IDLE);
    input.current?.focus();
  }

  const files = result.files;
  let status: string | null = null;
  if (!worktree) status = t("search.files.noWorktree");
  else if (result.phase === "searching") status = t("search.files.searching");
  else if (result.phase === "done") status = result.hits === 0 ? t("search.files.none") : t("search.files.summary", { hits: result.hits, files: files.length });
  else if (result.phase === "error") status = result.message;

  return (
    <div className="sr">
      <div className="sr-query">
        <input
          ref={input}
          className="sr-input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={t("search.files.placeholder")}
          aria-label={t("search.files.placeholder")}
          value={form.text}
          disabled={!worktree}
          onChange={(e) => set({ text: e.target.value })}
        />
        {toggle("caseSensitive", "search.files.caseSensitive", "Aa")}
        {toggle("wholeWord", "search.files.wholeWord", "ab")}
        {toggle("regex", "search.files.regex", ".*")}
      </div>
      <div className="sr-bar">
        <button type="button" className="sr-link" aria-expanded={details} title={t("search.files.toggleDetails")} onClick={() => setDetails((d) => !d)}>
          {t("search.files.toggleDetails")}
        </button>
        <span className="sr-spacer" />
        <button type="button" className="sr-link" disabled={files.length === 0} onClick={() => setFolded(new Set(files.map((f) => f.rel)))}>
          {t("search.files.collapseAll")}
        </button>
        <button type="button" className="sr-link" disabled={form.text === "" && files.length === 0} onClick={clear}>
          {t("search.files.clear")}
        </button>
      </div>
      {details && (
        <div className="sr-details">
          <input className="sr-input" type="text" spellCheck={false} placeholder={t("search.files.globHint")} aria-label={t("search.files.include")} value={form.include} onChange={(e) => set({ include: e.target.value })} />
          <input className="sr-input" type="text" spellCheck={false} placeholder={t("search.files.globHint")} aria-label={t("search.files.exclude")} value={form.exclude} onChange={(e) => set({ exclude: e.target.value })} />
        </div>
      )}
      {status && (
        <p className="sr-status" role={result.phase === "error" ? "alert" : "status"} data-error={result.phase === "error"}>
          {status}
        </p>
      )}
      {result.truncated && <p className="sr-status">{t("search.files.truncated", { count: HIT_MAX })}</p>}
      <div className="sr-results">
        {files.map((file) => {
          const closed = folded.has(file.rel);
          const name = fileName(file.rel);
          return (
            <div key={file.rel} className="sr-file">
              <button type="button" className="sr-file-head" aria-expanded={!closed} title={file.rel} onClick={() => flip(file.rel)}>
                <span className="sr-file-name">{name}</span>
                <span className="sr-file-dir">{file.rel.slice(0, Math.max(0, file.rel.length - name.length - 1))}</span>
                <span className="sr-count">{file.hits.length}</span>
              </button>
              {!closed &&
                file.hits.map((hit, i) => (
                  <button key={hit.line} type="button" className="sr-line" onClick={() => openHit(file, i)}>
                    <span className="sr-line-no">{hit.line}</span>
                    <span className="sr-line-text">
                      <Line text={hit.text} ranges={hit.ranges} />
                    </span>
                  </button>
                ))}
              {!closed && file.more && <p className="sr-more">{t("search.files.more")}</p>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
