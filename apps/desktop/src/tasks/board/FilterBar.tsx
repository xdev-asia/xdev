import { Button, FilterChip, SearchInput } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { BoardTask, TaskPriority, TaskStatus } from "@/api";
import { useI18n } from "@/i18n";
import { distinct, isFiltering, NO_FILTERS, type BoardFilters } from "./boardFilters";
import { COLUMNS } from "./boardModel";
import { statusKey } from "./TaskEditor";
import "@/styles/board.css";

const PRIORITIES: readonly TaskPriority[] = ["p0", "p1", "p2", "p3"];

const toggle = <T extends string>(list: T[], v: T): T[] => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

/** The search box and the chips shared by the Board and List views. */
export function FilterBar(props: { tasks: BoardTask[]; filters: BoardFilters; agentName(id: string): string; onChange(f: BoardFilters): void }): JSX.Element {
  const { t } = useI18n();
  const { filters: f, onChange } = props;
  const agents = distinct(props.tasks, (x) => x.assignee);
  const labels = distinct(props.tasks, (x) => x.labels);
  const group = (name: string, chips: JSX.Element[]): JSX.Element | null =>
    chips.length === 0 ? null : (
      <div className="board-filter-group" role="group" aria-label={name}>
        <span className="board-filter-name" aria-hidden="true">
          {name}
        </span>
        {chips}
      </div>
    );
  return (
    <div className="board-filters">
      <SearchInput
        name="board-search"
        aria-label={t("board.filter.search")}
        placeholder={t("board.filter.search")}
        value={f.search}
        onChange={(e) => onChange({ ...f, search: e.target.value })}
        onClear={() => onChange({ ...f, search: "" })}
      />
      {group(
        t("board.filter.status"),
        COLUMNS.map((s: TaskStatus) => (
          <FilterChip key={s} pressed={f.status.includes(s)} onClick={() => onChange({ ...f, status: toggle(f.status, s) })}>
            {t(statusKey(s))}
          </FilterChip>
        )),
      )}
      {group(
        t("board.filter.priority"),
        PRIORITIES.map((p) => (
          <FilterChip key={p} pressed={f.priority.includes(p)} onClick={() => onChange({ ...f, priority: toggle(f.priority, p) })}>
            {t(`board.priority.${p}`)}
          </FilterChip>
        )),
      )}
      {group(
        t("board.filter.assignee"),
        agents.map((a) => (
          <FilterChip key={a} pressed={f.agent.includes(a)} onClick={() => onChange({ ...f, agent: toggle(f.agent, a) })}>
            {props.agentName(a)}
          </FilterChip>
        )),
      )}
      {group(
        t("board.filter.label"),
        labels.map((l) => (
          <FilterChip key={l} pressed={f.label.includes(l)} onClick={() => onChange({ ...f, label: toggle(f.label, l) })}>
            {l}
          </FilterChip>
        )),
      )}
      {isFiltering(f) ? (
        <div>
          <Button variant="secondary" onClick={() => onChange(NO_FILTERS)}>
            {t("board.filter.clear")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
