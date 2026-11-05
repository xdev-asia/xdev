import { useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import type { PtyProfile, WorkStatus, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { profileLetter, profileName, useProfiles } from "@/agents/profileStore";
import { ContextMenu } from "@/ui/ContextMenu";
import { StatusGlyph } from "./StatusGlyph";
import type { TabStatus } from "./status";
import { dropColumn, groupByStatus, moveCard, moveItems, pastThreshold, statusOf, type ColumnBox, type ColumnId } from "./kanbanModel";
import "@/styles/kanban.css";

export interface KanbanBoardProps {
  /** The worktrees of the current project. */
  worktrees: WorktreeView[];
  selected: string | null;
  /** The status dot of each worktree path; null shows none. */
  dots: Record<string, TabStatus | null>;
  /** The profiles open in each worktree path, in tab order. */
  profiles?: Record<string, PtyProfile[]>;
  /** A click on a card: the shell selects the worktree and closes the board. */
  onSelect(worktree: WorktreeView): void;
  /** Writes the work status (null clears it) and resolves once the list has read it back; rejects on failure. */
  onMove(worktree: WorktreeView, status: WorkStatus | null): Promise<void>;
  /** A move failed and the card went back. */
  onMoveError(): void;
  onClose(): void;
}

/** A card being dragged: where the pointer is, and the column under it. */
interface Drag {
  path: string;
  x: number;
  y: number;
  over: ColumnId | null;
}

/** Every worktree of the project as a card, one column per work status; drag a card or use its Move to menu. */
export function KanbanBoard(props: KanbanBoardProps): JSX.Element {
  const { t } = useI18n();
  const { view } = useProfiles();
  const dialog = useRef<HTMLDialogElement>(null);
  const columns = useRef(new Map<ColumnId, HTMLElement>());
  const stop = useRef<(() => void) | null>(null);
  // A drag ends in a click on the card; that click must not open it.
  const dragged = useRef(false);
  // Statuses a move has set that the list has not read back yet.
  const [overrides, setOverrides] = useState<Record<string, WorkStatus | null>>({});
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ wt: WorktreeView; at: { x: number; y: number } } | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => stop.current?.();
  }, []);

  const move = (wt: WorktreeView, status: WorkStatus | null) => {
    void moveCard(wt, status, {
      apply: (path, to) => setOverrides((o) => ({ ...o, [path]: to })),
      settle: (path) =>
        setOverrides((o) => {
          const { [path]: _gone, ...rest } = o;
          return rest;
        }),
      write: () => props.onMove(wt, status),
    }).then((ok) => {
      if (!ok) props.onMoveError();
    });
  };

  const boxes = (): ColumnBox[] =>
    [...columns.current].map(([id, el]) => {
      const { left, right } = el.getBoundingClientRect();
      return { id, left, right };
    });

  // Pointer events, not HTML5 drag: the window's native drag-drop is on. A press becomes a drag past a small threshold.
  const press = (e: ReactPointerEvent, wt: WorktreeView) => {
    if (e.button !== 0 || wt.primary) return;
    const from = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const over = (ev: PointerEvent) => dropColumn(ev.clientX, boxes());
    const onMove = (ev: PointerEvent) => {
      if (!dragging && !pastThreshold(from, { x: ev.clientX, y: ev.clientY })) return;
      dragging = true;
      setDrag({ path: wt.path, x: ev.clientX, y: ev.clientY, over: over(ev) });
    };
    const onUp = (ev: PointerEvent) => {
      const target = dragging ? over(ev) : null;
      off();
      if (!dragging) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      setDrag(null);
      if (target) move(wt, statusOf(target));
    };
    const onCancel = () => {
      off();
      setDrag(null);
    };
    const off = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
      stop.current = null;
    };
    stop.current?.();
    stop.current = off;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  };

  const card = (wt: WorktreeView) => {
    const status = props.dots[wt.path] ?? null;
    const label = status ? t(`workspace.status.${status}`) : "";
    // Plain shells are not agents: only the agent profiles get a chip.
    const agents = (props.profiles?.[wt.path] ?? []).filter((p) => !p.startsWith("shell"));
    return (
      <li key={wt.path} className="ws-wt kb-card" data-path={wt.path} data-dragging={drag?.path === wt.path ? "true" : undefined}>
        <button
          type="button"
          className="ws-wt-main"
          title={wt.path}
          aria-current={props.selected === wt.path ? "true" : undefined}
          onPointerDown={(e) => press(e, wt)}
          onClick={() => {
            if (!dragged.current) props.onSelect(wt);
          }}
        >
          <span className="ws-wt-line">
            {status ? StatusGlyph({ status, label }) : <span className="ws-dot" data-dot="none" aria-hidden="true" />}
            <span className="ws-wt-name" title={wt.title ?? wt.name}>
              {wt.title ?? wt.name}
            </span>
          </span>
          <span className="ws-wt-sub">
            <span className="ws-wt-branch" title={wt.branch ?? undefined}>
              {wt.branch ?? t("workspace.detached")}
            </span>
          </span>
          {agents.length > 0 && (
            <span className="ws-wt-meta">
              {agents.map((p) => (
                <span key={p} className="ws-chip" data-profile={p} title={profileName(view, p, t)}>
                  {profileLetter(view, p)}
                </span>
              ))}
            </span>
          )}
        </button>
        {!wt.primary && (
          <button
            type="button"
            className="ws-wt-more"
            aria-label={t("kanban.moveLabel", { name: wt.title ?? wt.name })}
            title={t("kanban.moveMenu")}
            aria-haspopup="menu"
            aria-expanded={menu?.wt.path === wt.path}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenu({ wt, at: { x: box.left, y: box.bottom } });
            }}
          >
            ⋯
          </button>
        )}
      </li>
    );
  };

  const board = groupByStatus(props.worktrees, overrides);
  const name = (id: ColumnId) => (id === "none" ? t("workspace.groupBy.status.none") : t(`workspace.work.${id}`));
  const ghost = drag && props.worktrees.find((w) => w.path === drag.path);

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog kb"
      aria-labelledby="kb-title"
      data-dragging={drag ? "true" : undefined}
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <div className="kb-head">
        <h2 id="kb-title" className="dialog-title">
          {t("kanban.title")}
        </h2>
        <button type="button" className="ws-icon-btn" aria-label={t("kanban.close")} title={t("kanban.close")} onClick={props.onClose}>
          <svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>
      {props.worktrees.length === 0 ? (
        <p className="kb-none">{t("kanban.none")}</p>
      ) : (
        <div className="kb-board">
          {board.map((col) => (
            <section
              key={col.id}
              className="kb-col"
              data-column={col.id}
              data-over={drag?.over === col.id ? "true" : undefined}
              aria-label={t("kanban.columnLabel", { status: name(col.id), count: col.items.length })}
              ref={(el) => {
                if (el) columns.current.set(col.id, el);
                else columns.current.delete(col.id);
              }}
            >
              <h3 className="kb-col-head">
                <span className="kb-col-name">{name(col.id)}</span>
                <span className="ws-group-count">{col.items.length}</span>
              </h3>
              {col.items.length === 0 ? (
                <p className="kb-empty">{t("kanban.empty")}</p>
              ) : (
                <ul className="ws-wts kb-cards">{col.items.map(card)}</ul>
              )}
            </section>
          ))}
        </div>
      )}
      {ghost && drag && (
        <div className="kb-ghost" aria-hidden="true" style={{ left: drag.x, top: drag.y }}>
          {ghost.title ?? ghost.name}
        </div>
      )}
      {menu && <ContextMenu at={menu.at} items={moveItems(overrides[menu.wt.path] ?? menu.wt.status, (s) => move(menu.wt, s))} title={t("kanban.moveMenu")} onClose={() => setMenu(null)} />}
    </dialog>
  );
}
