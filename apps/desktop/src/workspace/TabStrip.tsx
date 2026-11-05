import { useEffect, useState } from "react";
import type { CSSProperties, JSX, ReactNode } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import type { Api, PtyProfile } from "@/api";
import { useI18n } from "@/i18n";
import { withChord } from "@/keys/hint";
import { fileName } from "@/files/fileTabs";
import { AgentIcon } from "./AgentIcon";
import type { PaneDir } from "./paneTree";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import type { Tab, TabColor } from "./sessions";
import { fileTabMenuItems, tabColorVar, tabMenuItems, type FileCloseKind, type MoveDir } from "./tabMenu";
import type { TabStatus } from "./status";
import type { DropZone } from "./sessions";
import { beforeOf, insertAt, pastThreshold, zoneFor } from "./tabDrag";
import { TabIndicator } from "./TabIndicator";
import { CardPortal, HOVER_DELAY_MS, TabHoverCard, useTabHover } from "./TabHoverCard";
import { cacheLeftMs, formatCacheLeft, useNow } from "./cacheTimer";
import { PaneChips } from "@/terminal/chips/PaneChips";
import { noteRuns } from "@/terminal/chips/runClocks";

/** One entry of a strip: a terminal tab, or the review tab or a file tab (`tab` is null). */
export interface StripItem {
  id: string;
  tab: Tab | null;
  /** Set for a file tab: its path in the worktree and whether it has unsaved edits. */
  file?: { rel: string; dirty: boolean; pinned?: boolean; markdown?: boolean; gone?: "deleted" | "renamed" };
  /** Set for a Markdown preview tab: the path of the file it shows. */
  preview?: { rel: string };
  /** Set for the commit tab: the commit it shows. */
  commit?: { id: string };
}

export interface MenuGroup {
  label: string;
  ids: PtyProfile[];
  /** The group ends with the "Agent…" item that opens the picker. */
  picker?: boolean;
}

/** What a drag in a strip tells its owner: the tab and the pane zone under the pointer. */
export interface TabDrag {
  id: string;
  over: { pane: string; zone: DropZone } | null;
}

interface PressState {
  id: string;
  x: number;
  y: number;
  pointerId: number;
  mark: { id: string; after: boolean } | null;
  over: { pane: string; zone: DropZone } | null;
}

/**
 * Middle-click handlers of a tab: they close it through `close`, the same path as the close button
 * (so its confirm dialogs run). Pinned tabs have no close button and ignore the middle button too.
 * Mouse-down on the middle button is cancelled so the webview does not start autoscroll.
 */
export function middleClick(id: string, pinned: boolean, close: (id: string) => void) {
  return {
    onMouseDown: (e: { button: number; preventDefault(): void }) => {
      if (e.button === 1) e.preventDefault();
    },
    onAuxClick: (e: { button: number; preventDefault(): void }) => {
      if (e.button !== 1) return;
      e.preventDefault();
      if (!pinned) close(id);
    },
  };
}

/** What the pointer is over during a tab drag: a spot in a strip, or a zone of a pane body. */
export function hitTest(pane: string, x: number, y: number): { mark: { id: string; after: boolean } | null; over: { pane: string; zone: DropZone } | null } {
  const el = document.elementFromPoint(x, y);
  const list = el?.closest(".ws-tablist");
  if (list && list.getAttribute("data-pane-id") === pane) {
    const boxes = Array.from(list.querySelectorAll("[data-tab-id]")).map((t) => {
      const r = t.getBoundingClientRect();
      return { id: t.getAttribute("data-tab-id")!, left: r.left, width: r.width };
    });
    return { mark: insertAt(boxes, x), over: null };
  }
  const zones = el?.closest("[data-dropzones]");
  const zone = zones ? zoneFor(zones.getBoundingClientRect(), x, y) : null;
  return { mark: null, over: zones && zone ? { pane: zones.getAttribute("data-dropzones")!, zone } : null };
}

/** Below this width a pane header keeps only a button for its chips. */
export const NARROW_STRIP_PX = 520;

/** The prompt cache countdown of a tab, or a "cold" mark once it ran out. */
function CacheBadge({ left }: { left: number }): JSX.Element {
  const { t } = useI18n();
  return left > 0 ? (
    <span className="ws-tab-cache" title={t("usage.cacheTimer.title", { time: formatCacheLeft(left) })}>
      {formatCacheLeft(left)}
    </span>
  ) : (
    <span className="ws-tab-cache ws-tab-cache-cold" title={t("usage.cacheTimer.coldTitle")}>
      {t("usage.cacheTimer.cold")}
    </span>
  );
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
  /** The terminal tab menu's Close all: every unpinned terminal and file tab of the worktree. */
  onCloseAll?: () => void;
  onLaunch: (profile: PtyProfile) => void;
  /** Shift+click on an agent of the `+` menu opens its launch options instead of launching; absent, Shift does nothing special. */
  onLaunchOptions?: (profile: PtyProfile) => void;
  /** Opens the picker in a mode that ends in the launch options; absent, the menu has no such item. */
  onLaunchOptionsPicker?: () => void;
  /** Opens the agent picker of this pane; absent, the menu has no "Agent…" item. */
  onAgentPicker?: () => void;
  /** The open agent picker of this pane, drawn under the `+` button. */
  agentPicker?: ReactNode;
  /** Splits this pane, opening the default shell in the new one. */
  onSplit: (dir: PaneDir) => void;
  /** Moves a tab of this pane into a new pane beside it. */
  onMoveToSplit: (id: string, dir: MoveDir) => void;
  /** A tab of this pane was dropped before `before` (null: at the end) of the strip. */
  onReorder?: (id: string, before: string | null) => void;
  /** A tab drag started (its id) or ended (null); the pane area shows drop zones meanwhile. */
  onDragTab?: (drag: TabDrag | null) => void;
  /** A tab was dropped on an edge zone of a pane. */
  onDropZone?: (id: string, pane: string, zone: DropZone) => void;
  onPin: (id: string, pinned: boolean) => void;
  onCopyTabId: (id: string) => void;
  /** The file tab menu's bulk closes: `kind` of the file tabs of this pane, around the tab `id`. */
  onCloseFiles?: (id: string, kind: FileCloseKind) => void;
  /** Copies the path of a file tab: relative to the worktree, or the full one. */
  onCopyFilePath?: (rel: string, relative: boolean) => void;
  /** Opens the Markdown preview of a file tab. */
  onOpenPreview?: (rel: string) => void;
  /** Opens the title dialog for a tab. */
  onChangeTitle: (id: string) => void;
  onColor: (id: string, color: TabColor) => void;
  onRename: (id: string, name: string) => void;
  /** Shows a resumed tab's session in the session history; absent when there is no history panel. */
  onShowHistory?: (sessionId: string) => void;
  menuOpen: boolean;
  onMenu: (open: boolean) => void;
  /** Drawn after the new-tab control (the Command button). */
  trailing?: ReactNode;
  /** Prompt cache timers: tab id → when it settled, and the cache lifetime. Absent: none drawn. */
  cache?: { timers: ReadonlyMap<string, number>; ttlMs: number };
  /** Draws the pane header chips (quota, context, run timer) and the note button for the front terminal tab; absent, none. */
  api?: Api;
  /** Tab ids that have a sticky note: they get a dot. */
  noteTabs?: ReadonlySet<string>;
  /** Opens the sticky note of a tab (the tab menu item and the header button). */
  onNote?: (id: string) => void;
  /** Opens the notes library. */
  onNotesLibrary?: () => void;
}): JSX.Element {
  const { items, active, groups, cache } = props;
  // One clock for the strip, running only while a timer on it still counts down.
  const stripNow = useNow(cache !== undefined && items.some((i) => i.tab && cache.timers.has(i.tab.id) && cacheLeftMs(cache.timers.get(i.tab.id)!, Date.now(), cache.ttlMs) > 0));
  const { t } = useI18n();
  const { view } = useProfiles();
  // The tab context menu: which tab, and where the pointer was.
  const [context, setContext] = useState<{ id: string; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [press] = useState<{ cur: PressState | null; dragging: boolean; suppress: boolean }>(() => ({ cur: null, dragging: false, suppress: false }));
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropMark, setDropMark] = useState<{ id: string; after: boolean } | null>(null);
  const hover = useTabHover();
  // A strip narrower than this folds its chips behind one button.
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    if (!root || typeof ResizeObserver === "undefined") return;
    const watch = new ResizeObserver(() => setNarrow(root.getBoundingClientRect().width < NARROW_STRIP_PX));
    watch.observe(root);
    return () => watch.disconnect();
  }, [root]);
  // The run timers follow every agent tab of this strip, front or not.
  useEffect(() => {
    noteRuns(items.flatMap((i) => (i.tab ? [i.tab] : [])));
  });
  const endDrag = () => {
    press.cur = null;
    press.dragging = false;
    setDragId(null);
    setDropMark(null);
    props.onDragTab?.(null);
  };
  // Escape cancels a drag in progress; the release that follows is no click.
  useEffect(() => {
    if (!dragId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      press.suppress = true;
      endDrag();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dragId]);
  const cardId = `ws-tab-card-${props.pane}`;

  const name = (tab: Tab) => profileName(view, tab.profileId, t);
  // What the strip shows: the terminal's own title once it set one, else the profile.
  const shownName = (tab: Tab) => tab.title ?? name(tab);
  const statusLabel = (status: TabStatus) => t(`workspace.tabs.status.${status}`);
  const labelOf = (item: StripItem) =>
    item.tab
      ? name(item.tab)
      : item.file
        ? fileName(item.file.rel)
        : item.preview
          ? t("files.preview.tab", { name: fileName(item.preview.rel) })
          : item.commit
            ? t("commitView.tab", { id: item.commit.id.slice(0, 7) })
            : t("review.tab");

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

  const hoverTab = hover.open ? (items.find((i) => i.id === hover.open!.id)?.tab ?? null) : null;
  const picked = context ? items.find((i) => i.id === context.id) : null;
  const canSplitTab = items.length > 1;
  const strip = items.flatMap((i) => (i.tab ? [i.tab] : []));

  // The tab menu; the review tab is no terminal, so it has no pin, colour or title.
  const contextItems = (item: StripItem): MenuItem[] => {
    // The commit tab stays in its pane: it has only Close.
    if (item.commit) return [{ id: "close", labelKey: "tabMenu.close", run: () => props.onClose(item.id) }];
    if (item.file) {
      const file = item.file;
      return fileTabMenuItems({
        rel: file.rel,
        files: items.flatMap((i) => (i.file ? [{ rel: i.file.rel, dirty: i.file.dirty, pinned: !!i.file.pinned }] : [])),
        canMoveToSplit: canSplitTab,
        ...(file.markdown && props.onOpenPreview ? { openPreview: () => props.onOpenPreview?.(file.rel) } : {}),
        moveToSplit: (dir) => props.onMoveToSplit(item.id, dir),
        setPinned: (pinned) => props.onPin(item.id, pinned),
        copyPath: () => props.onCopyFilePath?.(file.rel, false),
        copyRelativePath: () => props.onCopyFilePath?.(file.rel, true),
        close: () => props.onClose(item.id),
        closeOthers: () => props.onCloseFiles?.(item.id, "others"),
        closeToRight: () => props.onCloseFiles?.(item.id, "right"),
        closeSaved: () => props.onCloseFiles?.(item.id, "saved"),
        closeAll: () => props.onCloseFiles?.(item.id, "all"),
      });
    }
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
    const resumed = item.tab.resumeOf;
    const history: MenuItem[] =
      resumed && props.onShowHistory
        ? [
            { id: "sep-history", labelKey: "", kind: "separator" },
            { id: "history", labelKey: "agentSessions.showInHistory", run: () => props.onShowHistory?.(resumed) },
          ]
        : [];
    return [
      ...tabMenuItems({
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
      closeAll: () => props.onCloseAll?.(),
      }),
      ...history,
      ...(props.onNote
        ? [
            { id: "sep-note", labelKey: "", kind: "separator" as const },
            { id: "note", labelKey: "notes.menu.open", run: () => props.onNote?.(item.id) },
            ...(props.onNotesLibrary ? [{ id: "notes-library", labelKey: "notes.menu.library", run: () => props.onNotesLibrary?.() }] : []),
          ]
        : []),
    ];
  };
  const frontTab = items.find((i) => i.id === active)?.tab ?? null;

  return (
    <div className="ws-tabstrip" data-pane={props.pane} ref={setRoot}>
      <div className="ws-tablist" data-pane-id={props.pane} role="tablist" aria-label={t("workspace.tabs.label")}>
        {items.map((item) => {
          const tab = item.tab;
          const selected = item.id === active;
          return (
            <div
              key={item.id}
              className={item.file?.gone ? "ws-tab ws-tab-gone" : "ws-tab"}
              data-selected={selected}
              data-pinned={tab?.pinned || item.file?.pinned || undefined}
              data-color={tab && tab.color !== "none" ? tab.color : undefined}
              style={tab && tab.color !== "none" ? ({ "--ws-tab-color": `var(${tabColorVar(tab.color)!})` } as CSSProperties) : undefined}
              data-dragging={dragId === item.id || undefined}
              data-drop={dropMark?.id === item.id ? (dropMark.after ? "after" : "before") : undefined}
              data-tab-id={item.id}
              data-pane-id={props.pane}
              onPointerDown={(e) => {
                if (e.button !== 0 || !props.onReorder || renaming === item.id || (e.target as Element).closest(".ws-tab-close")) return;
                press.suppress = false;
                press.cur = { id: item.id, x: e.clientX, y: e.clientY, pointerId: e.pointerId, mark: null, over: null };
              }}
              onPointerMove={(e) => {
                const p = press.cur;
                if (!p || e.pointerId !== p.pointerId) return;
                if (!press.dragging) {
                  if (!pastThreshold(p, e.clientX, e.clientY)) return;
                  press.dragging = true;
                  e.currentTarget.setPointerCapture?.(e.pointerId);
                  hover.hide();
                  setDragId(p.id);
                }
                const h = hitTest(props.pane, e.clientX, e.clientY);
                p.mark = h.mark && h.mark.id !== p.id ? h.mark : null;
                p.over = h.over;
                setDropMark(p.mark);
                props.onDragTab?.({ id: p.id, over: p.over });
              }}
              onPointerUp={(e) => {
                const p = press.cur;
                if (!p || e.pointerId !== p.pointerId) return;
                if (press.dragging) {
                  press.suppress = true;
                  if (p.over) props.onDropZone?.(p.id, p.over.pane, p.over.zone);
                  else if (p.mark) props.onReorder?.(p.id, beforeOf(items.map((i) => i.id), p.mark));
                }
                endDrag();
              }}
              onPointerCancel={endDrag}
              onClickCapture={(e) => {
                if (!press.suppress) return;
                press.suppress = false;
                e.stopPropagation();
                e.preventDefault();
              }}
              {...middleClick(item.id, !!(tab?.pinned || item.file?.pinned), props.onClose)}
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
                  title={tab?.title ?? item.file?.rel ?? item.preview?.rel ?? (item.commit ? t("commitView.tab", { id: item.commit.id.slice(0, 7) }) : undefined)}
                  aria-describedby={tab && hover.open?.id === item.id ? cardId : undefined}
                  onMouseEnter={tab ? (e) => hover.show(item.id, e.currentTarget, HOVER_DELAY_MS) : undefined}
                  onMouseLeave={tab ? hover.hide : undefined}
                  onFocus={tab ? (e) => hover.show(item.id, e.currentTarget, 0) : undefined}
                  onBlur={tab ? hover.hide : undefined}
                  onClick={() => props.onSelect(item.id)}
                  onDoubleClick={() => tab && setRenaming(item.id)}
                >
                  {tab ? (
                    <>
                      <AgentIcon profile={tab.profileId} size={16} />
                      {tab.pinned && (
                        <span className="ws-tab-pin" role="img" aria-label={t("tabMenu.pinned")} title={t("tabMenu.pinned")}>
                          <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                            <path d="M10 1.5 14.5 6l-1.6.6-2.4 2.4.4 3.2-1.2 1.2L7 10.2 3.5 13.7 2.3 12.5 5.8 9 3.2 6.2 4.4 5l3.2.4L10 3z" fill="currentColor" />
                          </svg>
                        </span>
                      )}
                      <span className="ws-tab-name">{shownName(tab)}</span>
                      {tab.permissions === "skip" && (
                        <span className="ws-tab-skip" title={t("workspace.tabs.skipHint")}>
                          <span className="ws-tab-skip-dot" aria-hidden="true" />
                          {t("workspace.tabs.skip")}
                        </span>
                      )}
                      {/* Plain shells are not agents: no status mark. */}
                      {TabIndicator({ status: tab.agent ? tab.status : null, label: statusLabel(tab.status) })}
                      {cache && cache.timers.has(tab.id) && <CacheBadge left={cacheLeftMs(cache.timers.get(tab.id)!, stripNow, cache.ttlMs)} />}
                      {props.noteTabs?.has(tab.id) && <span className="ws-tab-note" role="img" aria-label={t("notes.tab.dot")} title={t("notes.tab.dot")} />}
                    </>
                  ) : (
                    <>
                      {item.file ? (
                        <>
                          {item.file.pinned && (
                            <span className="ws-tab-pin" role="img" aria-label={t("tabMenu.pinned")} title={t("tabMenu.pinned")}>
                              <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true">
                                <path d="M10 1.5 14.5 6l-1.6.6-2.4 2.4.4 3.2-1.2 1.2L7 10.2 3.5 13.7 2.3 12.5 5.8 9 3.2 6.2 4.4 5l3.2.4L10 3z" fill="currentColor" />
                              </svg>
                            </span>
                          )}
                          <span className="ws-tab-name">{fileName(item.file.rel)}</span>
                          {item.file.gone && <span className="ws-tab-gone-label">{t(`files.tab.${item.file.gone}`)}</span>}
                        </>
                      ) : (
                        <>
                          <span className="ws-tab-icon ws-mono" aria-hidden="true">
                            ±
                          </span>
                          <span>{labelOf(item)}</span>
                        </>
                      )}
                    </>
                  )}
                </button>
              )}
              {item.file?.dirty && <span className="ws-tab-dirty" role="img" aria-label={t("files.dirty")} title={t("files.dirty")} />}
              {!tab?.pinned && !item.file?.pinned && (
              <button
                type="button"
                className="ws-tab-close"
                aria-label={t("workspace.tabs.close", { name: labelOf(item) })}
                title={withChord(t, t("workspace.tabs.close", { name: labelOf(item) }), "tab.close")}
                onClick={() => props.onClose(item.id)}
              >
                ×
              </button>
              )}
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
                    <button
                      key={p}
                      type="button"
                      role="menuitem"
                      onClick={(e) => (e?.shiftKey && props.onLaunchOptions && g.picker ? props.onLaunchOptions(p) : props.onLaunch(p))}
                    >
                      {profileName(view, p, t)}
                    </button>
                  ))}
                  {g.picker && props.onAgentPicker && menuItem("agent-picker", t("workspace.tabs.agentPicker"), props.onAgentPicker)}
                  {g.picker && props.onLaunchOptionsPicker && menuItem("launch-options", t("workspace.tabs.launchOptions"), props.onLaunchOptionsPicker)}
                </div>
              ))}
              <div className="ws-menu-group" role="group">
                {menuItem("split-right", t("workspace.tabs.split.right"), () => props.onSplit("right"))}
                {menuItem("split-down", t("workspace.tabs.split.down"), () => props.onSplit("down"))}
              </div>
            </div>
          </>
        )}
        {props.agentPicker}
        {context && picked && (
          <ContextMenu at={{ x: context.x, y: context.y }} items={contextItems(picked)} onClose={() => setContext(null)} />
        )}
      </div>
      {props.api && frontTab && props.onNote && (
        <PaneChips api={props.api} tab={frontTab} narrow={narrow} hasNote={!!props.noteTabs?.has(frontTab.id)} onNote={() => props.onNote?.(frontTab.id)} />
      )}
      {props.trailing}
      {hoverTab && hover.open && (
        <CardPortal>
          <TabHoverCard
            id={cardId}
            at={hover.open}
            labels={{ agent: t("workspace.tabs.card.agent"), status: t("workspace.tabs.card.status"), cwd: t("workspace.tabs.card.cwd") }}
            data={{ title: shownName(hoverTab), agent: name(hoverTab), status: statusLabel(hoverTab.status), cwd: hoverTab.worktree }}
          />
        </CardPortal>
      )}
    </div>
  );
}
