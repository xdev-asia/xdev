import type { ISearchOptions } from "@xterm/addon-search";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { getFindOptions, setFindOptions, type FindOptions } from "./terminalFindOptions";

export type { FindOptions } from "./terminalFindOptions";

/** The part of `SearchAddon` the find bar uses. */
export interface SearchLike {
  findNext(term: string, options?: ISearchOptions): boolean;
  findPrevious(term: string, options?: ISearchOptions): boolean;
  clearDecorations(): void;
  onDidChangeResults(listener: (e: { resultIndex: number; resultCount: number }) => void): { dispose(): void };
}

type Decorations = NonNullable<ISearchOptions["decorations"]>;

// What each decoration colour reads (R8): raw tokens in `styles/base.css`.
const DECORATION_TOKENS: [keyof Decorations, string][] = [
  ["matchBackground", "--bg-3"],
  ["matchBorder", "--warn"],
  ["matchOverviewRuler", "--warn"],
  ["activeMatchBackground", "--accent"],
  ["activeMatchBorder", "--signal"],
  ["activeMatchColorOverviewRuler", "--signal"],
];

/**
 * The search decoration colours from the tokens. The addon requires `#rrggbb` for them, so a token
 * in any other form is left out. Decorations must be passed for the match count to be reported.
 */
export function searchDecorations(token: (name: string) => string | undefined): Decorations {
  const out: Partial<Record<keyof Decorations, string>> = {};
  for (const [key, name] of DECORATION_TOKENS) {
    const value = token(name)?.trim();
    if (value && /^#[0-9a-fA-F]{6}$/.test(value)) out[key] = value;
  }
  return out as Decorations;
}

const rootToken = (name: string): string | undefined =>
  typeof document === "undefined" ? undefined : getComputedStyle(document.documentElement).getPropertyValue(name);

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

type Count = { resultIndex: number; resultCount: number } | null;

const TOGGLES = [
  { id: "case", option: "caseSensitive", code: "KeyC", key: "C", glyph: "Aa" },
  { id: "regex", option: "regex", code: "KeyR", key: "R", glyph: ".*" },
  { id: "word", option: "wholeWord", code: "KeyW", key: "W", glyph: "ab" },
] as const;

/** The find bar of a terminal pane: query, three toggles, previous / next, a match count, close. */
export function TerminalFind(props: {
  search: SearchLike;
  /** The text the bar opens with (a one-line selection, or the last query). */
  initial: string;
  onClose(): void;
  /** A new value asks for the input to be focused and its text selected (Ctrl+F with the bar open). */
  focusSeq?: number;
  /** The query as typed, so the pane can reopen with it. */
  onQuery?(query: string): void;
}): JSX.Element {
  const { search } = props;
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(props.initial);
  const [options, setOptions] = useState<FindOptions>(getFindOptions);
  const [count, setCount] = useState<Count>(null);

  const invalid = options.regex && query !== "" && !compiles(query);

  // `incremental` keeps the current match while the query grows; a step moves to the next one.
  function run(q: string, opts: FindOptions, how: "type" | "next" | "prev"): void {
    if (q === "" || (opts.regex && !compiles(q))) {
      search.clearDecorations();
      setCount(null);
      return;
    }
    const decorations = searchDecorations(rootToken);
    const found =
      how === "prev"
        ? search.findPrevious(q, { ...opts, decorations })
        : how === "next"
          ? search.findNext(q, { ...opts, decorations })
          : search.findNext(q, { incremental: true, ...opts, decorations });
    if (!found) setCount({ resultIndex: -1, resultCount: 0 });
  }

  useEffect(() => {
    const sub = search.onDidChangeResults((e) => setCount(e));
    if (query !== "") run(query, options, "type");
    return () => {
      sub.dispose();
      search.clearDecorations();
    };
  }, [search]);

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, [props.focusSeq]);

  function toggle(option: keyof FindOptions): void {
    const next = { ...options, [option]: !options[option] };
    setOptions(next);
    setFindOptions(next);
    run(query, next, "type");
  }

  function close(): void {
    search.clearDecorations();
    props.onClose();
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(query, options, e.shiftKey ? "prev" : "next");
      return;
    }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyF") {
      e.preventDefault();
      input.current?.select();
      return;
    }
    const hit = e.altKey ? TOGGLES.find((x) => x.code === e.code) : undefined;
    if (hit) {
      e.preventDefault();
      toggle(hit.option);
    }
  }

  let countText = "";
  if (invalid) countText = t("terminal.find.invalid");
  else if (count) {
    if (count.resultCount === 0) countText = t("terminal.find.none");
    else if (count.resultIndex < 0) countText = t("terminal.find.many", { count: count.resultCount });
    else countText = t("terminal.find.count", { index: count.resultIndex + 1, count: count.resultCount });
  }

  return (
    <div className="terminal-find" role="search">
      <input
        ref={input}
        className="terminal-find-input"
        type="text"
        data-find="input"
        aria-label={t("terminal.search")}
        placeholder={t("terminal.search")}
        aria-invalid={invalid}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          props.onQuery?.(e.target.value);
          run(e.target.value, options, "type");
        }}
        onKeyDown={onKeyDown}
      />
      {TOGGLES.map((x) => (
        <button
          key={x.id}
          type="button"
          className="terminal-find-btn"
          data-find={x.id}
          aria-pressed={options[x.option]}
          aria-label={`${t(`terminal.find.${x.id}`)} (Alt+${x.key})`}
          title={`${t(`terminal.find.${x.id}`)} (Alt+${x.key})`}
          onClick={() => toggle(x.option)}
        >
          {x.glyph}
        </button>
      ))}
      <span className="terminal-find-count" data-find="count" role="status" aria-live="polite">
        {countText}
      </span>
      <button
        type="button"
        className="terminal-find-btn"
        data-find="prev"
        aria-label={t("terminal.find.prev")}
        title={t("terminal.find.prev")}
        onClick={() => run(query, options, "prev")}
      >
        ↑
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        data-find="next"
        aria-label={t("terminal.find.next")}
        title={t("terminal.find.next")}
        onClick={() => run(query, options, "next")}
      >
        ↓
      </button>
      <button
        type="button"
        className="terminal-find-btn"
        data-find="close"
        aria-label={t("terminal.find.close")}
        title={t("terminal.find.close")}
        onClick={close}
      >
        ×
      </button>
    </div>
  );
}
