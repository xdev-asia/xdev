import { currentTheme, onThemeChange, readThemeColors, type ObserverFactory } from "@xdev-asia/ui";

/** Whether the app is in light mode now (the root has `data-theme=light`). */
export function appIsLight(root: { getAttribute(name: string): string | null } | undefined = typeof document === "undefined" ? undefined : document.documentElement): boolean {
  return root ? currentTheme(root) === "light" : false;
}

/** The CSS variables the xterm options read (`xtermOptions`, `terminalTheme`). */
export const TERMINAL_TOKENS = ["--x-font-mono", "--x-color-surface", "--x-color-ink"] as const;

type Root = Parameters<typeof onThemeChange>[0] & Element;
type Style = Parameters<typeof readThemeColors>[2];

/**
 * Calls `apply(token, light)` with freshly read variables each time the app theme changes, so an open
 * terminal follows a switch between light and dark. Returns the unsubscribe; does nothing where
 * there is no DOM. `makeObserver` and `getStyle` are for tests.
 */
export function followAppTheme(
  el: Element,
  apply: (token: (name: string) => string | undefined, light: boolean) => void,
  root: Root | undefined = typeof document === "undefined" ? undefined : document.documentElement,
  makeObserver?: ObserverFactory,
  getStyle?: Style,
): () => void {
  if (!root || (!makeObserver && typeof MutationObserver === "undefined")) return () => {};
  return onThemeChange(
    root,
    (mode) => {
      const colors = readThemeColors(el, TERMINAL_TOKENS, getStyle);
      apply((name) => colors[name] || undefined, mode === "light");
    },
    makeObserver,
  );
}
