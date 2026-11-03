import { useEffect } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { IS_MAC as MAC } from "@/platform";

const HINT = MAC ? "⌘ K" : "Ctrl K";
const JUMP_HINT = MAC ? "⌘ J" : "Ctrl J";

/**
 * The search box in the middle of the header: a button with its shortcut. Ctrl+K always opens search;
 * with `onJump` the button opens the jump palette instead and shows Ctrl J.
 */
export function HeaderSearch(props: { onOpen: () => void; onJump?: () => void }): JSX.Element {
  const { onOpen, onJump } = props;
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
    <button type="button" className="ws-search" onClick={onJump ?? onOpen}>
      <svg aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
        <circle cx="11" cy="11" r="7" />
        <path d="m20 20-3.5-3.5" />
      </svg>
      <span className="ws-search-label">{t("workspace.header.search")}</span>
      <kbd className="ws-search-hint">{onJump ? JUMP_HINT : HINT}</kbd>
    </button>
  );
}
