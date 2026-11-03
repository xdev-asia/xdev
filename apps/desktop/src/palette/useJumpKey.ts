import { useKeymap } from "@/keys/keymap";
import { IS_MAC } from "@/platform";

/**
 * Cmd+J on macOS, Ctrl+J elsewhere, with nothing else held and not auto-repeating. The physical
 * J key counts too, so a non-Latin layout still reaches it.
 */
export function isJumpKey(e: KeyboardEvent, mac: boolean = IS_MAC): boolean {
  const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  return mod && !e.shiftKey && !e.altKey && !e.repeat && (e.code === "KeyJ" || e.key.toLowerCase() === "j");
}

/**
 * Calls `onToggle` on the jump key: the `palette.jump` binding of the keymap, taken in the capture
 * phase and stopped, so a focused terminal never receives the line feed.
 */
export function useJumpKey(onToggle: () => void): void {
  useKeymap({ "palette.jump": () => onToggle() });
}
