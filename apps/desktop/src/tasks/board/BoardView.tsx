import { Badge, Banner, Board, BoardCard, BoardColumn, Button, Disclosure, EmptyState, IconButton, StatusDot, Tag } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, PointerEvent as ReactPointerEvent } from "react";
import type { BoardTask, TaskLink, TaskStatus, Unreadable } from "@/api";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { dropColumn, pastThreshold, type ColumnBox, type ColumnId } from "@/workspace/kanbanModel";
import { COLUMNS, groupByStatus, keyMove } from "./boardModel";
import { statusKey } from "./TaskEditor";
import "@/styles/kanban.css";
import "@/styles/board.css";

export interface BoardViewProps {
  /** The tasks to show (after the filters). */
  tasks: BoardTask[];
  /** How many tasks the repo has, filtered or not: 0 is the empty state, more with none shown is "no match". */
  total: number;
  unreadable: Unreadable[];
  links: TaskLink[];
  /** Whether the tab of a link is still open. */
  tabOpen(link: TaskLink): boolean;
  /** The name of an agent profile id. */
  agentName(id: string): string;
  onOpen(task: BoardTask): void;
  onNew(status: TaskStatus): void;
  onStart(task: BoardTask): void;
  onMove(task: BoardTask, to: TaskStatus): void;
  onOpenTab(link: TaskLink): void;
  onClearFilters(): void;
  /** Lane task-decompose passes it; without it the button is not shown. */
  onDecompose?(): void;
  /** Without it the card menu has no Delete. */
  onDelete?(task: BoardTask): void;
}

/** A card's menu: start, the columns to move to, then Delete set apart. */
export function taskMenu(task: BoardTask, h: { onStart(task: BoardTask): void; move(task: BoardTask, to: TaskStatus): void; onDelete?(task: BoardTask): void }): MenuItem[] {
  const items: MenuItem[] = [
    { id: "start", labelKey: "board.start", run: () => h.onStart(task) },
    { id: "sep", labelKey: "board.start", kind: "separator" },
    ...COLUMNS.map((s): MenuItem => ({ id: `move:${s}`, labelKey: statusKey(s), checked: task.status === s, run: () => h.move(task, s) })),
  ];
  const onDelete = h.onDelete;
  if (onDelete) items.push({ id: "sep:delete", labelKey: "board.delete", kind: "separator" }, { id: "delete", labelKey: "board.delete", danger: true, run: () => onDelete(task) });
  return items;
}

interface Drag {
  id: string;
  x: number;
  y: number;
  over: TaskStatus | null;
}

/** The unreadable files as one banner that opens into a list of reasons. */
export function UnreadableBanner({ items }: { items: Unreadable[] }): JSX.Element | null {
  const { t } = useI18n();
  if (items.length === 0) return null;
  return (
    <div className="board-unreadable">
      <Banner title={t("board.unreadable.title", { count: items.length })} />
      <Disclosure title={t("board.unreadable.show")} count={items.length} defaultExpanded={false}>
        <ul className="board-unreadable-list">
          {items.map((u) => (
            <li key={u.file}>{t("board.unreadable.reason", { file: u.file, reason: u.reason })}</li>
          ))}
        </ul>
      </Disclosure>
    </div>
  );
}

/** Five columns of task cards; drag a card, press Alt+Left or Alt+Right on it, or use its menu to move it. */
export function BoardView(props: BoardViewProps): JSX.Element {
  const { t } = useI18n();
  const cols = useRef<HTMLDivElement>(null);
  const stop = useRef<(() => void) | null>(null);
  // A drag ends in a click on the card; that click must not open it.
  const dragged = useRef(false);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [menu, setMenu] = useState<{ task: BoardTask; at: { x: number; y: number } } | null>(null);
  const [announce, setAnnounce] = useState("");
  const link = (id: string) => props.links.find((l) => l.id === id);

  useEffect(() => () => stop.current?.(), []);

  const move = (task: BoardTask, to: TaskStatus): void => {
    if (task.status === to) return;
    props.onMove(task, to);
    setAnnounce(t("board.moved", { title: task.title, status: t(statusKey(to)) }));
  };

  // The columns are the Board's children in order, so index i is COLUMNS[i].
  const boxes = (): ColumnBox[] =>
    [...(cols.current?.querySelectorAll<HTMLElement>(".x-board-col") ?? [])].map((el, i) => {
      const { left, right } = el.getBoundingClientRect();
      return { id: COLUMNS[i] as ColumnId, left, right };
    });

  // Pointer events, not HTML5 drag, as on the worktree board: the window's native drag-drop is on.
  const press = (e: ReactPointerEvent, task: BoardTask): void => {
    if (e.button !== 0) return;
    const from = { x: e.clientX, y: e.clientY };
    let dragging = false;
    const over = (ev: PointerEvent): TaskStatus | null => (dropColumn(ev.clientX, boxes()) as TaskStatus | null);
    const onMove = (ev: PointerEvent): void => {
      if (!dragging && !pastThreshold(from, { x: ev.clientX, y: ev.clientY })) return;
      dragging = true;
      setDrag({ id: task.id, x: ev.clientX, y: ev.clientY, over: over(ev) });
    };
    const onUp = (ev: PointerEvent): void => {
      const target = dragging ? over(ev) : null;
      off();
      if (!dragging) return;
      dragged.current = true;
      setTimeout(() => (dragged.current = false), 0);
      setDrag(null);
      if (target) move(task, target);
    };
    const onCancel = (): void => {
      off();
      setDrag(null);
    };
    const off = (): void => {
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

  const menuItems = (task: BoardTask): MenuItem[] => taskMenu(task, { onStart: props.onStart, move, onDelete: props.onDelete });

  const card = (task: BoardTask): JSX.Element => {
    const l = link(task.id);
    const open = l ? props.tabOpen(l) : false;
    const name = t("board.menu", { title: task.title });
    return (
      <BoardCard
        key={task.id}
        data-task={task.id}
        title={task.title}
        dragging={drag?.id === task.id}
        // A press starts a drag and Alt+Arrow moves; the card's own buttons do neither.
        onPointerDown={(e) => {
          if (!(e.target as HTMLElement).closest("button")) press(e, task);
        }}
        onKeyDown={(e) => {
          const to = keyMove(e.key, e.altKey, task.status);
          if (!to || e.target !== e.currentTarget) return;
          e.preventDefault();
          move(task, to);
        }}
        onOpen={() => {
          if (!dragged.current) props.onOpen(task);
        }}
        meta={
          <>
            <span className="board-card-meta">
              <Badge>{t(`board.priority.${task.priority}`)}</Badge>
              {task.assignee ? <span className="board-card-agent">{props.agentName(task.assignee)}</span> : null}
            </span>
            {l ? (
              <span className="board-linked">
                {open ? <StatusDot tone="accent" label={t("board.linked", { tab: l.tabTitle })} /> : <span className="board-linked-gone">{t("board.linked.gone")}</span>}
              </span>
            ) : null}
          </>
        }
        actions={
          l && open ? (
            <Button variant="secondary" onClick={() => props.onOpenTab(l)}>
              {t("board.linked.open")}
            </Button>
          ) : undefined
        }
        tags={task.labels.length > 0 ? task.labels.map((x) => <Tag key={x}>{x}</Tag>) : undefined}
        menu={
          <IconButton
            icon="more"
            label={name}
            onClick={(e) => {
              const box = e.currentTarget.getBoundingClientRect();
              setMenu({ task, at: { x: box.left, y: box.bottom } });
            }}
          />
        }
      />
    );
  };

  const ghost = drag && props.tasks.find((x) => x.id === drag.id);
  const grouped = groupByStatus(props.tasks);
  let body: JSX.Element;
  if (props.total === 0) {
    body = (
      <EmptyState
        size="center"
        icon="file-plus"
        title={t("board.empty.title")}
        hint={t("board.empty.body")}
        actions={
          <>
            <Button onClick={() => props.onNew("backlog")}>{t("board.new")}</Button>
            {props.onDecompose ? (
              <Button variant="secondary" onClick={props.onDecompose}>
                {t("board.empty.decompose")}
              </Button>
            ) : null}
          </>
        }
      />
    );
  } else if (props.tasks.length === 0) {
    body = (
      <EmptyState
        size="center"
        title={t("board.filter.none")}
        actions={
          <Button variant="secondary" onClick={props.onClearFilters}>
            {t("board.filter.clear")}
          </Button>
        }
      />
    );
  } else {
    body = (
      <div className="board-cols" ref={cols} data-dragging={drag ? "true" : undefined}>
        <Board aria-label={t("tasks.title")}>
          {grouped.map((col) => {
            const name = t(statusKey(col.status));
            return (
              <BoardColumn
                key={col.status}
                title={name}
                count={col.tasks.length}
                dropTarget={drag?.over === col.status}
                aria-label={t("board.col.label", { status: name, count: col.tasks.length })}
                actions={<IconButton icon="plus" label={`${t("board.new")}: ${name}`} onClick={() => props.onNew(col.status)} />}
              >
                {col.tasks.map(card)}
              </BoardColumn>
            );
          })}
        </Board>
      </div>
    );
  }

  return (
    <div className="board-view">
      <UnreadableBanner items={props.unreadable} />
      {body}
      <p className="board-announce" role="status">
        {announce}
      </p>
      {ghost && drag ? (
        <div className="kb-ghost" aria-hidden="true" style={{ left: drag.x, top: drag.y }}>
          {ghost.title}
        </div>
      ) : null}
      {menu ? <ContextMenu at={menu.at} items={menuItems(menu.task)} title={menu.task.title} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
