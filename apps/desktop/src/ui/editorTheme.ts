import { useSyncExternalStore } from "react";
import type { ResolvedTheme } from "@xdev-asia/ui";
import type { EditorTheme, UiSettings } from "@/api";

// The editor and the diff follow the app's light / dark tokens. `UiSettings.editorThemeLight` and
// `editorThemeDark` pick another scheme for them: the host element gets `data-theme`, and the
// tokens under it read as that scheme.

type Prefs = Pick<UiSettings, "editorThemeLight" | "editorThemeDark">;

/** The `data-theme` an editor host takes, or `undefined` to inherit the app's. */
export function editorThemeFor(app: ResolvedTheme, prefs: Prefs): ResolvedTheme | undefined {
  const pick: EditorTheme = app === "light" ? prefs.editorThemeLight : prefs.editorThemeDark;
  return pick === "light" || pick === "dark" ? pick : undefined;
}

type Snapshot = { app: ResolvedTheme; prefs: Prefs };

let snapshot: Snapshot = { app: "dark", prefs: { editorThemeLight: "app", editorThemeDark: "app" } };
const listeners = new Set<() => void>();

function publish(next: Snapshot): void {
  if (next.app === snapshot.app && next.prefs.editorThemeLight === snapshot.prefs.editorThemeLight && next.prefs.editorThemeDark === snapshot.prefs.editorThemeDark) return;
  snapshot = next;
  listeners.forEach((l) => l());
}

/** Called by `ui/theme.ts` when the painted theme changes. */
export function setPaintedTheme(app: ResolvedTheme): void {
  publish({ ...snapshot, app });
}

/** Called by `ui/theme.ts` with the stored settings. */
export function setEditorPrefs(prefs: Prefs): void {
  publish({ ...snapshot, prefs: { editorThemeLight: prefs.editorThemeLight, editorThemeDark: prefs.editorThemeDark } });
}

/** Tests only. */
export function resetEditorThemeForTests(): void {
  snapshot = { app: "dark", prefs: { editorThemeLight: "app", editorThemeDark: "app" } };
}

/** Calls `l` when the app theme or the pick changes. Returns the unsubscribe. */
export function onEditorThemeChange(l: () => void): () => void {
  listeners.add(l);
  return () => void listeners.delete(l);
}

/** The `data-theme` an editor takes now, outside React. */
export function currentEditorTheme(): ResolvedTheme | undefined {
  return editorThemeFor(snapshot.app, snapshot.prefs);
}

/** For an editor host: `<div data-theme={useEditorTheme()}>`. Re-renders when the setting or the app theme changes. */
export function useEditorTheme(): ResolvedTheme | undefined {
  const s = useSyncExternalStore(onEditorThemeChange, () => snapshot, () => snapshot);
  return editorThemeFor(s.app, s.prefs);
}
