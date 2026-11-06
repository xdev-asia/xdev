import { useEffect, useMemo, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import type { Api } from "@/api";
import { isAbsolutePath, relUnder } from "@/files/linkPath";
import { useI18n } from "@/i18n";
import { IS_MAC } from "@/platform";
import { Highlight } from "@/palette/Highlight";
import type { Range } from "@/palette/match";
import "@/palette/palette.css";
import { rankFiles, splitLine } from "./quickOpen";
import type { RecentFiles } from "./recentFiles";

/** How long a file list is reused for the same worktree. */
export const FILE_LIST_TTL_MS = 30_000;

interface Listed {
  at: number;
  files: string[];
  truncated: boolean;
}
const cache = new Map<string, Listed>();

/** The files of `worktree`, from the cache while it is fresh; a failed read is an empty list and is not kept. */
export function readFileList(read: Api["filesList"], worktree: string, now: number): Promise<{ files: string[]; truncated: boolean }> {
  const hit = cache.get(worktree);
  if (hit && now - hit.at < FILE_LIST_TTL_MS) return Promise.resolve({ files: hit.files, truncated: hit.truncated });
  return read(worktree).then(
    (list) => {
      cache.set(worktree, { at: now, files: list.files, truncated: list.truncated });
      return { files: list.files, truncated: list.truncated };
    },
    () => ({ files: [], truncated: false }),
  );
}

/** Forgets every cached file list; for tests. */
export function resetFileListCache(): void {
  cache.clear();
}

export interface QuickOpenProps {
  open: boolean;
  api: Api;
  /** The worktree on screen; null when there is none. */
  worktree: string | null;
  recent: RecentFiles;
  /** `side` is Mod+Enter: open in a new pane to the right. */
  onOpen(rel: string, opts: { line?: number; column?: number; side: boolean }): void;
  onClose(): void;
  now?: () => number;
}

// The parts of `hits` that fall in [from, to), moved to start at 0.
function clip(hits: Range[], from: number, to: number): Range[] {
  const out: Range[] = [];
  for (const [s, e] of hits) {
    const a = Math.max(s, from);
    const b = Math.min(e, to);
    if (a < b) out.push([a - from, b - from]);
  }
  return out;
}

/** The "Go to file" dialog: a name or path query and the ranked files of the worktree. */
export function QuickOpenDialog(props: QuickOpenProps): JSX.Element {
  const { open, api, worktree, recent, onOpen, onClose } = props;
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const [listed, setListed] = useState<{ worktree: string; files: string[]; truncated: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    if (!worktree) return;
    const now = (props.now ?? Date.now)();
    const hit = cache.get(worktree);
    if (hit && now - hit.at < FILE_LIST_TTL_MS) {
      setListed({ worktree, files: hit.files, truncated: hit.truncated });
      return;
    }
    setListed(null);
    let stale = false;
    api.filesList(worktree).then(
      (list) => {
        cache.set(worktree, { at: now, files: list.files, truncated: list.truncated });
        if (!stale) setListed({ worktree, files: list.files, truncated: list.truncated });
      },
      () => {
        if (!stale) setListed({ worktree, files: [], truncated: false });
      },
    );
    return () => {
      stale = true;
    };
  }, [open, worktree]);

  // Focus goes back to where it was when the dialog opened.
  useEffect(() => {
    if (!open || typeof document === "undefined") return;
    const before = document.activeElement as HTMLElement | null;
    return () => before?.focus?.();
  }, [open]);

  const ready = listed && listed.worktree === worktree ? listed : null;
  const { query: typed, line, column } = splitLine(query);
  // An absolute path inside the worktree is ranked as its relative path, that file first; outside, it matches nothing.
  const inside = worktree && isAbsolutePath(typed.trim()) ? relUnder(worktree, typed.trim()) : null;
  const text = inside ?? typed;
  const rows = useMemo(() => {
    if (!ready || !worktree) return [];
    const ranked = rankFiles(ready.files, text, recent.list(worktree));
    const exact = inside === null ? -1 : ranked.findIndex((r) => r.rel === inside);
    return exact > 0 ? [ranked[exact]!, ...ranked.slice(0, exact), ...ranked.slice(exact + 1)] : ranked;
  }, [ready, text, inside, worktree, recent, open]);
  const at = Math.min(selected, Math.max(0, rows.length - 1));
  const recentSet = worktree && text.trim() === "" ? new Set(recent.list(worktree)) : null;

  function run(rel: string | undefined, side: boolean) {
    if (!rel) return;
    onClose();
    onOpen(rel, { line, column, side });
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setSelected(rows.length ? (at + 1) % rows.length : 0);
        break;
      case "ArrowUp":
        e.preventDefault();
        setSelected(rows.length ? (at - 1 + rows.length) % rows.length : 0);
        break;
      case "Home":
        e.preventDefault();
        setSelected(0);
        break;
      case "End":
        e.preventDefault();
        setSelected(Math.max(0, rows.length - 1));
        break;
      case "Enter":
        e.preventDefault();
        run(rows[at]?.rel, e.ctrlKey || e.metaKey);
        break;
    }
  }

  const reveal = (el: HTMLDivElement | null) => el?.scrollIntoView?.({ block: "nearest" });

  return (
    <dialog
      ref={(d) => {
        if (!d) return;
        if (open && !d.open) d.showModal();
        if (!open && d.open) d.close();
      }}
      className="palette"
      aria-labelledby="quick-open-title"
      onKeyDown={onKeyDown}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="quick-open-title" className="pal-title">
        {t("quickOpen.label")}
      </h2>
      <input
        className="pal-input"
        type="text"
        autoFocus
        spellCheck={false}
        autoComplete="off"
        placeholder={t("quickOpen.placeholder", { shortcut: "Ctrl+P" })}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setSelected(0);
        }}
      />
      <div className="pal-list" role="listbox">
        {!ready && <p className="pal-empty">{t("quickOpen.loading")}</p>}
        {ready && rows.length === 0 && <p className="pal-empty">{t("quickOpen.empty", { query: text })}</p>}
        {ready && recentSet && rows.length > 0 && recentSet.has(rows[0].rel) && <div className="pal-section">{t("quickOpen.recent")}</div>}
        {rows.map((row, i) => {
          const on = i === at;
          const cut = row.rel.lastIndexOf("/") + 1;
          return (
            <div key={row.rel} role="option" aria-selected={on} ref={on ? reveal : undefined} className="pal-row" data-selected={on} onClick={() => run(row.rel, false)}>
              <span className="pal-title-text">
                <Highlight text={row.rel.slice(cut)} hits={clip(row.hits, cut, row.rel.length)} />
              </span>
              {cut > 0 && (
                <span className="pal-detail">
                  <Highlight text={row.rel.slice(0, cut - 1)} hits={clip(row.hits, 0, cut - 1)} />
                </span>
              )}
            </div>
          );
        })}
        {ready?.truncated && <p className="pal-empty">{t("quickOpen.truncated", { count: "50 000" })}</p>}
      </div>
      <div className="pal-foot">
        <span>
          <kbd>↑↓</kbd> {t("palette.hint.move")}
        </span>
        <span>
          <kbd>Enter</kbd> {t("palette.hint.open")}
        </span>
        <span>{t("search.quickOpen.sideHint", { key: IS_MAC ? "Cmd" : "Ctrl" })}</span>
        <span>
          <kbd>Esc</kbd> {t("palette.hint.close")}
        </span>
      </div>
    </dialog>
  );
}
