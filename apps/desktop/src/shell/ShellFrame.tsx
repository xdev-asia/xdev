import type { JSX, ReactNode } from "react";
import { ActivityBar, AppShell, type AppId } from "@xdev-asia/ui";
import type { Place } from "./places";

/** The places the rail switches between. Settings has its own button in the header. */
export type RailView = Place;

export interface ShellFrameLabels {
  workspace: string;
  docs: string;
  tasks: string;
  squads: string;
  kit: string;
  accounts: string;
  automations: string;
  /** aria-label of the rail. */
  rail: string;
  /** aria-label of the sidebar. */
  sidebar: string;
  openNav: string;
  closeNav: string;
  skipToContent: string;
}

/**
 * The one frame of the app: title bar, the places rail, the design system `AppShell` (brand and side list on the
 * left, header and stage on the right) and the status bar. It holds no state; the shell hands everything in.
 */
export function ShellFrame(props: {
  titlebar: ReactNode;
  view: Place;
  onView: (view: Place) => void;
  /** The places the rail lists, in order. Settings is never one of them. */
  places: Place[];
  labels: ShellFrameLabels;
  /** Desktop: the side list folds away. */
  sidebarOpen: boolean;
  /** Narrow: the side list is a drawer. */
  navOpen: boolean;
  onNavOpenChange: (open: boolean) => void;
  brand: ReactNode;
  sidebar: ReactNode;
  crumbs: ReactNode;
  actions: ReactNode;
  footer: ReactNode;
  /** Below 768px: the bottom bar with the places; the design system hides it from 768px up. */
  bottomNav?: ReactNode;
  /** Dialogs, hosts and toasts that sit above the frame. */
  overlays?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  const { labels } = props;
  // `ActivityBar` names the workspace place `terminal`; Automations is an extra item. Settings is not a rail place,
  // so it leaves the rail without a highlight.
  const apps = props.places.flatMap((p): AppId[] => (p === "workspace" ? ["terminal"] : p === "automations" || p === "settings" ? [] : [p]));
  const automations = props.places.includes("automations");
  const active = props.view === "workspace" ? "terminal" : props.view === "settings" ? "" : props.view;
  return (
    <div className="ws-shell">
      {props.titlebar}
      <div className="ws-frame">
        <div className="ws-rail">
          <ActivityBar
            apps={apps}
            extraItems={automations ? [{ id: "automations", icon: "automation", label: labels.automations }] : undefined}
            active={active}
            labels={{ terminal: labels.workspace, docs: labels.docs, tasks: labels.tasks, squads: labels.squads, kit: labels.kit, accounts: labels.accounts, nav: labels.rail }}
            onSelect={(id) => props.onView(id === "terminal" ? "workspace" : (id as Place))}
          />
        </div>
        <AppShell
          className={props.sidebarOpen ? "ws-appshell" : "ws-appshell ws-side-off"}
          brand={props.brand}
          nav={props.sidebar}
          crumbs={props.crumbs}
          actions={props.actions}
          navOpen={props.navOpen}
          onNavOpenChange={props.onNavOpenChange}
          bottomNav={props.bottomNav}
          labels={{ nav: labels.sidebar, openNav: labels.openNav, closeNav: labels.closeNav, skipToContent: labels.skipToContent }}
        >
          {props.children}
        </AppShell>
      </div>
      {props.footer}
      {props.overlays}
    </div>
  );
}
