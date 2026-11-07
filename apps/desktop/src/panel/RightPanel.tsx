import type { CSSProperties, JSX, ReactNode } from "react";
import { Icon, SplitHandle, Tabs, type IconName } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { issuesTabVisible } from "@/issues/issuesPreset";
import type { PanelTab } from "@/workspace/shellModel";

/** What the tab row shows besides the selection. */
export interface PanelTabState {
  /** Changed files of the worktree; a badge on Changes. */
  changes: number;
  /** Failing checks; a danger badge on Checks. */
  failing: number;
  /** The Issues tab shows (git host has issues, pinned, or already open). */
  issuesTab: boolean;
  issuesPinned: boolean;
}

export interface PanelTabBarProps extends PanelTabState {
  tab: PanelTab;
  /** `focusSearch` is set for the Search tab, which takes focus when it opens. */
  onTab(tab: PanelTab, focusSearch?: boolean): void;
}

interface TabDef {
  id: PanelTab;
  icon: IconName;
  label: string;
  /** aria-label when it differs from `label` (a count was added). */
  aria?: string;
  badge?: { count: number; tone?: "danger" };
}

/** The icon row on top of the right panel: the design system tabs, compact. */
export function PanelTabBar(props: PanelTabBarProps): JSX.Element {
  const { t } = useI18n();
  const { tab, changes, failing } = props;
  const defs: TabDef[] = [
    { id: "files", icon: "folder", label: t("workspace.panel.files") },
    { id: "search", icon: "search", label: t("search.files.tab") },
    {
      id: "changes",
      icon: "branch",
      label: t("workspace.panel.changes"),
      aria: changes > 0 ? t("workspace.panel.changesCount", { count: changes }) : t("workspace.panel.changes"),
      badge: changes > 0 ? { count: changes } : undefined,
    },
    { id: "pr", icon: "pull-request", label: t("prPanel.tab") },
    {
      id: "checks",
      icon: "check-circle",
      label: t("checks.tab"),
      aria: failing > 0 ? t("checks.tabFailing", { count: failing }) : t("checks.tab"),
      badge: failing > 0 ? { count: failing, tone: "danger" } : undefined,
    },
    ...(issuesTabVisible(props.issuesTab, props.issuesPinned, tab === "issues") ? [{ id: "issues", icon: "info", label: t("issues.tab") } satisfies TabDef] : []),
    { id: "ports", icon: "plug", label: t("ports.tab") },
  ];
  // Icon tabs: the name is for screen readers (with the count when there is one) and the tooltip.
  return (
    <Tabs
      size="sm"
      className="ws-panel-tabs"
      label={t("workspace.panel.label")}
      value={tab}
      onChange={(id) => props.onTab(id as PanelTab, id === "search")}
      items={defs.map((d) => ({
        id: d.id,
        label: (
          <span className="ws-panel-tab" title={d.label}>
            <Icon name={d.icon} size={16} />
            <span className="x-sr-only">{d.aria ?? d.label}</span>
          </span>
        ),
        badge: d.badge ? <span aria-hidden="true">{d.badge.count}</span> : undefined,
        badgeTone: d.badge?.tone,
      }))}
    />
  );
}

/** The right panel's width, px: the design token's 300 until it is resized, within these bounds. */
export const PANEL_DEFAULT = 300;
export const PANEL_MIN = 240;
export const PANEL_MAX = 640;

/** A saved or dragged width brought within the bounds; null (never resized) stays null. */
export function clampPanelWidth(px: number | null): number | null {
  return px === null || !Number.isFinite(px) ? null : Math.min(PANEL_MAX, Math.max(PANEL_MIN, Math.round(px)));
}

export interface RightPanelProps extends PanelTabBarProps {
  open: boolean;
  /** The width the person gave it, px; null keeps the design token's. */
  width?: number | null;
  /** Called while the handle on its left edge is dragged or moved with the arrow keys. */
  onResize?(px: number): void;
  /** The tab bodies. All stay mounted, so the change list and the open folders survive a tab switch. */
  children: ReactNode;
}

/** The right side of the stage: the tab row, then one body per tab. */
export function RightPanel(props: RightPanelProps): JSX.Element {
  const { t } = useI18n();
  return (
    <>
      {props.open && props.onResize && (
        <SplitHandle
          className="ws-panel-handle"
          direction="horizontal"
          reverse
          value={props.width ?? PANEL_DEFAULT}
          min={PANEL_MIN}
          max={PANEL_MAX}
          label={t("workspace.panel.resize")}
          onResize={props.onResize}
        />
      )}
      <aside className="ws-panel" hidden={!props.open} aria-label={t("workspace.panel.label")} style={props.width != null ? ({ "--w-panel": `${props.width}px` } as CSSProperties) : undefined}>
        <PanelTabBar {...props} />
        {props.children}
      </aside>
    </>
  );
}
