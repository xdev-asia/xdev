import { useState } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import type { PtyProfile } from "@/api";
import { useI18n } from "@/i18n";
import { withChord } from "@/keys/hint";
import { AgentIcon } from "./AgentIcon";
import type { PaneDir } from "./paneTree";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import type { Tab, TabColor } from "./sessions";
import { tabMenuItems } from "./tabMenu";
import type { TabStatus } from "./status";
import { StatusGlyph } from "./StatusGlyph";

/** One entry of a strip: a terminal tab, or the review tab (`tab` is null). */
export interface StripItem {
  id: string;
  tab: Tab | null;
}

export interface MenuGroup {
  label: string;
  ids: PtyProfile[];
}

/**
 * The tab strip of one pane: its tabs, the `+` menu (new tab, split) and the tab context menu.
 * It only draws; what each action does is the caller's.
 */
export function TabStrip(props: {
  pane: string;
  items: StripItem[];
  active: string | null;
  groups: MenuGroup[];
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onCloseOthers: (id: string) => void;
  onCloseToRight: (id: string) => void;
  onLaunch: (profile: PtyProfile) => void;
  /** Splits this pane, opening the default shell in the new one. */
  onSplit: (dir: PaneDir) => void;
  /** Moves a tab of this pane into a new pane beside it. */
  onMoveToSplit: (id: string, dir: PaneDir) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCopyTabId: (id: string) => void;
  /** Opens the title dialog for a tab. */
  onChangeTitle: (id: string) => void;
  onColor: (id: string, color: TabColor) => void;
  onRename: (id: string, name: string) => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
}): JSX.Element {
  const { items, active, groups } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  // The tab context menu: which tab, and where the pointer was.
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);

  const name = (tab: Tab) => profileName(view, tab.profileId, t);
  // What the strip shows: the terminal's own title once it set one, else the profile.
  const shownName = (tab: Tab) => tab.title ?? name(tab);
  const statusLabel = (status: TabStatus) => t(`workspace.tabs.status.${status}`);
  const labelOf = (item: StripItem) => (item.tab ? name(item.tab) : t("review.tab"));

  const menuItem = (key: string, label: string, run: () => void, extra?: { danger?: boolean; disabled?: boolean }) => (
    <button
      key={key}
      type="button"
      role="menuitem"
      className={extra?.danger ? "ws-menu-danger" : undefined}
      aria-disabled={extra?.disabled ? true : undefined}
      onClick={() => {
        if (extra?.disabled) return;
        setContext(null);
        props.onMenu(false);
        run();
      }}
    >
      {label}
    </button>
  );

  const picked = context ? items.find((i) => i.id === context.id) : null;
  const canSplitTab = items.length > 1;
  const strip = items.flatMap((i) => (i.tab ? [i.tab] : []));

  // The tab menu; the review tab is no terminal, so it has no pin, colour or title.
  const contextItems = (item: StripItem): MenuItem[] => {
    if (!item.tab) {
      return [
        {
          id: "moveToSplit",
          labelKey: "tabMenu.moveToSplit",
          disabled: !canSplitTab,
          children: [
            { id: "moveRight", labelKey: "tabMenu.moveRight", run: () => props.onMoveToSplit(item.id, "right") },
            { id: "moveDown", labelKey: "tabMenu.moveDown", run: () => props.onMoveToSplit(item.id, "down") },
          ],
        },
        { id: "close", labelKey: "tabMenu.close", run: () => props.onClose(item.id) },
      ];
    }
    return tabMenuItems({
      tab: item.tab,
      tabs: strip,
      canMoveToSplit: canSplitTab,
      split: props.onSplit,
      moveToSplit: (dir) => props.onMoveToSplit(item.id, dir),
      setPinned: (pinned) => props.onPin(item.id, pinned),
      copyTabId: () => props.onCopyTabId(item.id),
      changeTitle: () => props.onChangeTitle(item.id),
      setColor: (color) => props.onColor(item.id, color),
      close: () => props.onClose(item.id),
      closeOthers: () => props.onCloseOthers(item.id),
      closeToRight: () => props.onCloseToRight(item.id),
    });
  };

  return (
    <div className="ws-tabstrip" data-pane={props.pane}>
      <div className="ws-tablist" role="tablist" aria-label={t("workspace.tabs.label")}>
        {items.map((item) => {
          const tab = item.tab;
          const selected = item.id === active;
          return (
            <div
              key={item.id}
              className="ws-tab"
              data-selected={selected}
              onContextMenu={(e) => {
                e.preventDefault();
                props.onMenu(false);
                setContext({ id: item.id, x: e.clientX, y: e.clientY });
              }}
            >
              {renaming === item.id && tab ? (
                <input
                  className="ws-tab-rename"
                  defaultValue={shownName(tab)}
                  aria-label={t("panes.rename")}
                  autoFocus
                  onBlur={() => setRenaming(null)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") setRenaming(null);
                    if (e.key !== "Enter") return;
                    props.onRename(item.id, e.currentTarget.value);
                    setRenaming(null);
                  }}
                />
              ) : (
                <button
                  type="button"
                  role="tab"
                  className={tab?.unread ? "ws-tab-main ws-tab-unread" : "ws-tab-main"}
                  data-tab={item.id}
                  aria-selected={selected}
                  aria-label={
                    tab?.unread
                      ? t("workspace.tabs.unreadLabel", { name: shownName(tab), status: statusLabel(tab.status).toLocaleLowerCase() })
                      : undefined
                  }
                  title={tab?.title ?? undefined}
                  onClick={() => props.onSelect(item.id)}
                  onDoubleClick={() => tab && setRenaming(item.id)}
                >
                  {tab ? (
                    <>
                      <AgentIcon profile={tab.profileId} size={16} />
                      <span className="ws-tab-name">{shownName(tab)}</span>
                      {tab.permissions === "skip" && (
                        <span className="ws-tab-skip" title={t("workspace.tabs.skipHint")}>
                          <span className="ws-tab-skip-dot" aria-hidden="true" />
                          {t("workspace.tabs.skip")}
                        </span>
                      )}
                      {/* Plain shells are not agents: no status mark. */}
                      {StatusGlyph({ status: tab.agent ? tab.status : null, label: statusLabel(tab.status) })}
                    </>
                  ) : (
                    <>
                      <span className="ws-tab-icon ws-mono" aria-hidden="true">
                        ±
                      </span>
                      <span>{t("review.tab")}</span>
                    </>
                  )}
                </button>
              )}
              <button
                type="button"
                className="ws-tab-close"
                aria-label={t("workspace.tabs.close", { name: labelOf(item) })}
                title={withChord(t, t("workspace.tabs.close", { name: labelOf(item) }), "tab.close")}
                onClick={() => props.onClose(item.id)}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="ws-tab-add">
        <button
          type="button"
          className="ws-icon-btn"
          aria-label={t("workspace.tabs.new")}
          title={withChord(t, t("workspace.tabs.new"), "tab.new")}
          aria-haspopup="menu"
          aria-expanded={props.menuOpen}
          onClick={() => props.onMenu(!props.menuOpen)}
        >
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
        {props.menuOpen && (
          <>
            <div className="ws-menu-backdrop" onClick={() => props.onMenu(false)} />
            <div className="ws-menu" role="menu">
              {groups.map((g) => (
                <div key={g.label} className="ws-menu-group" role="group" aria-label={g.label}>
                  <div className="ws-menu-label" aria-hidden="true">
                    {g.label}
                  </div>
                  {g.ids.map((p) => (
                    <button key={p} type="button" role="menuitem" onClick={() => props.onLaunch(p)}>
                      {profileName(view, p, t)}
                    </button>
                  ))}
                </div>
              ))}
              <div className="ws-menu-group" role="group">
                {menuItem("split-right", t("workspace.tabs.split.right"), () => props.onSplit("right"))}
                {menuItem("split-down", t("workspace.tabs.split.down"), () => props.onSplit("down"))}
              </div>
            </div>
          </>
        )}
        {context && picked && (
          <ContextMenu at={{ x: context.x, y: context.y }} items={contextItems(picked)} onClose={() => setContext(null)} />
        )}
      </div>
    </div>
  );
}
