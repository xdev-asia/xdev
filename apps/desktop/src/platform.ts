/** True on macOS (and iOS-family webviews), where shortcuts use Cmd instead of Ctrl. */
export const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
