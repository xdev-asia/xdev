/** True on macOS (and iOS-family webviews), where shortcuts use Cmd instead of Ctrl. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);

/** The platform a shortcut's defaults and a `keybindings.json` section are picked for. */
export type Platform = "win" | "mac" | "linux";

export const PLATFORM: Platform = IS_MAC
  ? "mac"
  : typeof navigator !== "undefined" && /Linux|X11/.test(navigator.userAgent) && !/Android/.test(navigator.userAgent)
    ? "linux"
    : "win";
