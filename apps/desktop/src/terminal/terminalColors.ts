import { onThemeChange, readThemeColors, type ObserverFactory } from "@xdev-asia/ui";

/** The CSS variables the xterm options read (`xtermOptions`, `terminalTheme`). */
export const TERMINAL_TOKENS = ["--x-font-mono", "--x-color-surface", "--x-color-ink"] as const;

type Root = Parameters<typeof onThemeChange>[0] & Element;
type Style = Parameters<typeof readThemeColors>[2];

/**
 * Calls `apply(token)` with freshly read variables each time the app theme changes, so an open
 * terminal follows a switch between light and dark. Returns the unsubscribe; does nothing where
 * there is no DOM. `makeObserver` and `getStyle` are for tests.
 */
export function followAppTheme(
  el: Element,
  apply: (token: (name: string) => string | undefined) => void,
  root: Root | undefined = typeof document === "undefined" ? undefined : document.documentElement,
  makeObserver?: ObserverFactory,
  getStyle?: Style,
): () => void {
  if (!root || (!makeObserver && typeof MutationObserver === "undefined")) return () => {};
  return onThemeChange(
    root,
    () => {
      const colors = readThemeColors(el, TERMINAL_TOKENS, getStyle);
      apply((name) => colors[name] || undefined);
    },
    makeObserver,
  );
}
