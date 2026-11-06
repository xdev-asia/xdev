import { Dialog, SearchInput } from "@xdev-asia/ui";
import { useEffect, useId, useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { toApiError, type Api, type LspSymbol } from "@/api";
import { useI18n } from "@/i18n";
import { useDebounced } from "../debounce";

/** How long the query stays still before it goes to the servers. */
export const SYMBOL_DELAY_MS = 150;

// LSP SymbolKind numbers with a word of their own; the others read as "symbol".
const KINDS: Record<number, string> = { 2: "module", 3: "namespace", 5: "class", 6: "method", 7: "property", 8: "field", 9: "constructor", 10: "enum", 11: "interface", 12: "function", 13: "variable", 14: "constant", 22: "enumMember", 23: "struct", 26: "typeParameter" };

export type Found = { query: string; items: LspSymbol[]; error: string | null };

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The line under the field: why the list is empty, or nothing while the answer is not in yet. */
export function symbolMessage(found: Found | null, query: string, t: T): string {
  if (found === null || found.query !== query.trim()) return "";
  if (found.error === "lsp_not_found") return t("lsp.symbols.noServer");
  if (found.error) return t(`error.${found.error}`);
  return found.items.length === 0 ? t("lsp.symbols.empty") : "";
}

/** The row an arrow key moves to; the list wraps. */
export function moveActive(active: number, key: string, count: number): number {
  if (count === 0) return 0;
  return (active + (key === "ArrowDown" ? 1 : count - 1)) % count;
}

/** "Go to symbol": searches the worktree's language servers as the person types; Enter opens the chosen one. */
export function SymbolDialog(props: {
  api: Pick<Api, "lspWorkspaceSymbols">;
  worktree: string;
  onOpen(symbol: LspSymbol): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Found | null>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const asked = useDebounced(query.trim(), SYMBOL_DELAY_MS);

  useEffect(() => {
    if (asked === "") return void setFound(null);
    let live = true;
    api.lspWorkspaceSymbols(worktree, asked).then(
      (items) => live && (setFound({ query: asked, items, error: null }), setActive(0)),
      (e: unknown) => live && setFound({ query: asked, items: [], error: toApiError(e).code }),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, asked]);

  const items = found?.items ?? [];
  const message = symbolMessage(found, query, t);
  const chosen = items[active];

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => moveActive(a, e.key, items.length));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (chosen) props.onOpen(chosen);
    }
  };

  return (
    <Dialog modal size="default" title={t("lsp.symbols.title")} confirmLabel={t("lsp.symbols.open")} cancelLabel={t("lsp.symbols.cancel")} confirmDisabled={!chosen} onConfirm={() => chosen && props.onOpen(chosen)} onCancel={props.onClose}>
      <div className="lsp-symbols">
        <SearchInput
          size="md"
          value={query}
          placeholder={t("lsp.symbols.placeholder")}
          aria-label={t("lsp.symbols.placeholder")}
          role="combobox"
          aria-expanded={items.length > 0}
          aria-controls={`${id}-list`}
          aria-activedescendant={chosen ? `${id}-${active}` : undefined}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onClear={() => setQuery("")}
          onKeyDown={onKeyDown}
        />
        <p className="lsp-symbols-note" role="status">
          {message}
        </p>
        <ul className="lsp-symbols-list" role="listbox" id={`${id}-list`} aria-label={t("lsp.symbols.title")}>
          {items.map((s, i) => (
            <li
              key={`${s.rel}:${s.range.start.line}:${s.range.start.character}:${s.name}`}
              id={`${id}-${i}`}
              role="option"
              aria-selected={i === active}
              className="lsp-symbol"
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onClick={() => props.onOpen(s)}
            >
              <span className="lsp-symbol-name">{s.name}</span>
              <span className="lsp-symbol-kind">{t(`lsp.kind.${KINDS[s.kind] ?? "symbol"}`)}</span>
              <span className="lsp-symbol-rel">{s.rel}</span>
            </li>
          ))}
        </ul>
      </div>
    </Dialog>
  );
}
