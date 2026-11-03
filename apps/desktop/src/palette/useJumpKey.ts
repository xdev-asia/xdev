import { useEffect } from "react";

/** Ctrl+J, or Cmd+J on macOS, with nothing else held and not auto-repeating. */
export function isJumpKey(e: KeyboardEvent): boolean {
  return (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && !e.repeat && e.key.toLowerCase() === "j";
}

/**
 * Calls `onToggle` on Ctrl+J. It is taken in the capture phase and stopped, so a focused
 * terminal never receives the line feed.
 */
export function useJumpKey(onToggle: () => void): void {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!isJumpKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      onToggle();
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onToggle]);
}
