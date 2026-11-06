import type { LinksTarget } from "@/api";

/**
 * Where a terminal link goes: the setting `browser.openLinksIn`, turned around while Shift is held.
 * Only `http(s)` URLs can go to a browser tab; anything else stays with the system.
 */
export function routeLink(setting: LinksTarget, shift: boolean, url: string): LinksTarget {
  if (!/^https?:\/\//i.test(url)) return "system";
  const pane = setting === "pane";
  return pane !== shift ? "pane" : "system";
}

/**
 * Whether a link sent to a browser tab leaves the keyboard and the pane focus where they are. It
 * moves to the page only when the setting sent it there; a Shift click is a side trip.
 */
export function linkKeepsFocus(setting: LinksTarget, shift: boolean): boolean {
  return !(setting === "pane" && !shift);
}
