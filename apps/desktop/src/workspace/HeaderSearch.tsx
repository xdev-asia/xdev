import { useEffect } from "react";
import type { JSX } from "react";
import { useI18n } from "../i18n";

const MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const HINT = MAC ? "⌘ K" : "Ctrl K";

/** The search box in the middle of the header: a button that opens search, with its shortcut. */
export function HeaderSearch(props: { onOpen: () => void }): JSX.Element {
  const { onOpen } = props;
  const { t } = useI18n();

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        onOpen();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onOpen]);

  return (
    <button type="button" className="ws-search" onClick={onOpen}>
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span className="ws-search-label">{t("workspace.header.search")}</span>
      <kbd className="ws-search-hint">{HINT}</kbd>
    </button>
  );
}
