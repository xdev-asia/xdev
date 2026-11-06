import { Button, DataTable, EmptyState, Tag, type DataTableColumn, type TableSort } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { BoardTask } from "@/api";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { byPriority, COLUMNS } from "./boardModel";
import { statusKey } from "./TaskEditor";
import "@/styles/board.css";

/** The tasks in the order of `sort`; with none, by priority and then newest update first. */
export function sortTasks(tasks: readonly BoardTask[], sort: TableSort | null, agentName: (id: string) => string = (id) => id): BoardTask[] {
  const rows = [...tasks].sort(byPriority);
  if (!sort) return rows;
  const sign = sort.dir === "asc" ? 1 : -1;
  const text = (t: BoardTask): string | number => {
    switch (sort.key) {
      case "title":
        return t.title.toLowerCase();
      case "status":
        return COLUMNS.indexOf(t.status);
      case "priority":
        return t.priority;
      case "agent":
        return t.assignee ? agentName(t.assignee).toLowerCase() : "￿";
      case "labels":
        return t.labels.join(",").toLowerCase();
      default:
        return t.updated;
    }
  };
  // `rows` is already in the default order, and the sort is stable, so equal rows keep it.
  return rows.sort((a, b) => {
    const x = text(a);
    const y = text(b);
    return sign * (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y)));
  });
}

export interface TaskListProps {
  tasks: BoardTask[];
  total: number;
  agentName(id: string): string;
  onOpen(task: BoardTask): void;
  onNew(): void;
  onClearFilters(): void;
}

/** The tasks as a table. The title opens the editor; a header sorts by its column. */
export function TaskList(props: TaskListProps): JSX.Element {
  const { t } = useI18n();
  const [sort, setSort] = useState<TableSort | null>(null);
  const now = Date.now();
  const columns: DataTableColumn<BoardTask>[] = [
    {
      key: "title",
      header: t("board.field.title"),
      sortable: true,
      cell: (x) => (
        <button type="button" className="board-link" onClick={() => props.onOpen(x)}>
          {x.title}
        </button>
      ),
    },
    { key: "status", header: t("board.field.status"), sortable: true, cell: (x) => t(statusKey(x.status)) },
    { key: "priority", header: t("board.field.priority"), sortable: true, cell: (x) => t(`board.priority.${x.priority}`) },
    { key: "agent", header: t("board.field.assignee"), sortable: true, hideNarrow: true, cell: (x) => (x.assignee ? props.agentName(x.assignee) : "") },
    {
      key: "labels",
      header: t("board.field.labels"),
      sortable: true,
      hideNarrow: true,
      cell: (x) => (
        <span className="board-card-meta">
          {x.labels.map((l) => (
            <Tag key={l}>{l}</Tag>
          ))}
        </span>
      ),
    },
    { key: "updated", header: t("board.field.updated"), sortable: true, hideNarrow: true, cell: (x) => ago(Date.parse(x.updated), now, t) },
  ];
  const empty =
    props.total === 0 ? (
      <EmptyState
        title={t("board.empty.title")}
        hint={t("board.empty.body")}
        actions={<Button onClick={props.onNew}>{t("board.new")}</Button>}
      />
    ) : (
      <EmptyState
        title={t("board.filter.none")}
        actions={
          <Button variant="secondary" onClick={props.onClearFilters}>
            {t("board.filter.clear")}
          </Button>
        }
      />
    );
  return (
    <div className="board-list">
      <DataTable
        columns={columns}
        rows={sortTasks(props.tasks, sort, props.agentName)}
        rowKey={(x) => x.id}
        rowLabel={(x) => x.title}
        caption={t("board.list.caption")}
        sort={sort}
        onSortChange={setSort}
        empty={empty}
      />
    </div>
  );
}
