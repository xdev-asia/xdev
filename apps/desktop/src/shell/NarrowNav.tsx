import { BottomNav, type BottomNavItem } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import type { RailView } from "./ShellFrame";

/** The places the narrow bar reaches: the rail's, plus Tasks and Accounts, which open inside Docs. */
export type NarrowPlace = "sessions" | "tasks" | "docs" | "automations" | "accounts" | "settings";

/** The bar's tab for the page on screen; Tasks and Accounts live in Docs, so Docs stands for them. */
export function narrowValue(view: RailView): NarrowPlace {
  return view === "workspace" ? "sessions" : view;
}

/**
 * The bottom bar below 768px: Sessions, Tasks and Docs, and "More" with a sheet for Automations (when shown),
 * Accounts and Settings. From 768px up the design system hides it and the rail and header carry the same places.
 */
export function NarrowNav(props: { view: RailView; automations: boolean; onPick(place: NarrowPlace): void }): JSX.Element {
  const { t } = useI18n();
  const items: BottomNavItem[] = [
    { id: "sessions", label: t("shell.narrow.sessions"), icon: "terminal" },
    { id: "tasks", label: t("shell.narrow.tasks"), icon: "tasks" },
    { id: "docs", label: t("workspace.nav.docs"), icon: "docs" },
  ];
  const more: BottomNavItem[] = [
    ...(props.automations ? [{ id: "automations", label: t("workspace.nav.automations"), icon: "automation" } as const] : []),
    { id: "accounts", label: t("shell.narrow.accounts"), icon: "accounts" },
    { id: "settings", label: t("shell.narrow.settings"), icon: "settings" },
  ];
  return (
    <BottomNav
      className="ws-bottom-nav"
      items={items}
      value={narrowValue(props.view)}
      onChange={(id) => props.onPick(id as NarrowPlace)}
      more={{ label: t("shell.narrow.more"), icon: "more", items: more }}
      labels={{ nav: t("shell.narrow.label"), badge: (count) => t("shell.narrow.badge", { count }) }}
    />
  );
}
