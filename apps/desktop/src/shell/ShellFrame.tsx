import type { JSX, ReactNode } from "react";
import { ActivityBar, AppShell, Icon } from "@xdev-asia/ui";

/** The places the rail switches between. Settings has its own button in the header. */
export type RailView = "workspace" | "docs" | "automations" | "settings";

export interface ShellFrameLabels {
  workspace: string;
  docs: string;
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
  view: RailView;
  onView: (view: RailView) => void;
  /** Whether the Automations place shows in the rail. */
  automations: boolean;
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
  // `ActivityBar` highlights `active`; a place it does not list ("kit") leaves the rail without a highlight.
  const active = props.view === "workspace" ? "terminal" : props.view === "docs" ? "docs" : "kit";
  return (
    <div className="ws-shell">
      {props.titlebar}
      <div className="ws-frame">
        <div className="ws-rail">
          <ActivityBar
            apps={["terminal", "docs"]}
            active={active}
            labels={{ terminal: labels.workspace, docs: labels.docs, nav: labels.rail }}
            onSelect={(id) => props.onView(id === "docs" ? "docs" : "workspace")}
          />
          {props.automations && (
            <nav className="activitybar ws-rail-extra" aria-label={labels.automations}>
              <button
                type="button"
                className="activity"
                data-nav="automations"
                aria-label={labels.automations}
                title={labels.automations}
                aria-current={props.view === "automations" ? "page" : undefined}
                onClick={() => props.onView("automations")}
              >
                <Icon name="clock" size={22} />
              </button>
            </nav>
          )}
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
