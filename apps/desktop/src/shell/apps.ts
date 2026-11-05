export type AppId = "docs" | "changes" | "tasks" | "squads" | "agents" | "kit" | "accounts" | "terminal";

export const APPS: readonly AppId[] = ["docs", "changes", "tasks", "squads", "agents", "kit", "accounts", "terminal"];

/** All apps: the known ids of `raw` once each, then the apps it left out in `APPS` order. */
export function orderedApps(raw: readonly string[] = []): AppId[] {
  const order: AppId[] = [];
  for (const id of raw) if ((APPS as readonly string[]).includes(id) && !order.includes(id as AppId)) order.push(id as AppId);
  for (const id of APPS) if (!order.includes(id)) order.push(id);
  return order;
}

/** `clean_app_order` in Rust: `orderedApps`, or none when that is the default order. */
export function cleanAppOrder(raw: readonly string[]): string[] {
  const order = orderedApps(raw);
  return order.every((id, i) => id === APPS[i]) ? [] : order;
}

/** The apps the activity bar shows: `orderedApps` without the hidden ones (unknown ids ignored). Hiding all of them shows all. */
export function visibleApps(hidden: readonly string[], order: readonly string[] = []): AppId[] {
  const all = orderedApps(order);
  const shown = all.filter((id) => !hidden.includes(id));
  return shown.length > 0 ? shown : all;
}

/** `app` itself while it is visible, else the first visible app. */
export function resolveApp(app: AppId, hidden: readonly string[], order: readonly string[] = []): AppId {
  const shown = visibleApps(hidden, order);
  return shown.includes(app) ? app : shown[0];
}
