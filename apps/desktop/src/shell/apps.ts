export type AppId = "docs" | "changes" | "tasks" | "squads" | "agents" | "kit" | "accounts" | "terminal";

export const APPS: readonly AppId[] = ["docs", "changes", "tasks", "squads", "agents", "kit", "accounts", "terminal"];

/** The apps the activity bar shows: `APPS` without the hidden ones (unknown ids ignored). Hiding all of them shows all. */
export function visibleApps(hidden: readonly string[]): AppId[] {
  const shown = APPS.filter((id) => !hidden.includes(id));
  return shown.length > 0 ? shown : [...APPS];
}

/** `app` itself while it is visible, else the first visible app. */
export function resolveApp(app: AppId, hidden: readonly string[]): AppId {
  const shown = visibleApps(hidden);
  return shown.includes(app) ? app : shown[0];
}
