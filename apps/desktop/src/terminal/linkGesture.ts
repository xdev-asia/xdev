import type { TerminalLinkClick } from "@/api";

export type LinkKind = "file" | "url";
// What a click on a link does: show the action menu, open it, open the file with the default app,
// or leave the click to the terminal (selection).
export type LinkAction = "menu" | "open" | "openDefault" | "none";

export type LinkGesture = { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean };
export type LinkSettings = { linkClick: TerminalLinkClick; urlMiddleClick: TerminalLinkClick };

const FROM_SETTING: Record<TerminalLinkClick, LinkAction> = { actions: "menu", open: "open", none: "none" };

/**
 * The action for a mouse gesture on a link. `Mod` is Ctrl, and ⌘ on macOS (where Ctrl+click is a
 * right click, so Ctrl alone is no gesture there). Alt is xterm's own selection mode. Shift alone
 * is left to xterm: it is how a program that tracks the mouse lets a link be clicked.
 */
export function linkAction(kind: LinkKind, e: LinkGesture, settings: LinkSettings, mac: boolean): LinkAction {
  if (e.altKey) return "none";
  if (mac && e.ctrlKey) return "none";
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (e.button === 1) return kind === "url" ? FROM_SETTING[settings.urlMiddleClick] : "none";
  if (e.button !== 0) return "none";
  if (mod) return e.shiftKey && kind === "file" ? "openDefault" : "open";
  if (e.shiftKey) return "none";
  return FROM_SETTING[settings.linkClick];
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

/** The hover tip: the target and what a click does with the current setting. */
export function linkHint(kind: LinkKind, target: string, linkClick: TerminalLinkClick, mac: boolean, t: Translate): string {
  const actions = linkClick === "actions" ? t("termLink.hint.actions") : "";
  const open = t(mac ? "termLink.hint.clickMac" : "termLink.hint.click");
  if (kind === "url") return t("termLink.hint.url", { url: target, actions, open });
  const alt = t(mac ? "termLink.hint.altClickMac" : "termLink.hint.altClick");
  return t("termLink.hint.file", { path: target, actions, open, alt });
}
