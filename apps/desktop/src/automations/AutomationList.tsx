import type { JSX } from "react";
import { Icon, StatusDot, Switch, type MenuEntry } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { lastRunCell, sortLabel, type Row, type Sort, type SortKey } from "./listModel";
import { MenuButton } from "./MenuButton";

export type RowAction = "run" | "edit" | "toggle" | "delete";

/** The automations as a table: Name with its schedule, Project, Last run, Status and an actions menu. */
export function AutomationList(props: {
  rows: readonly Row[];
  sort: Sort | null;
  onSort(key: SortKey): void;
  selected: string | null;
  onSelect(id: string): void;
  onAction(id: string, action: RowAction): void;
  /** The schedule label of each automation, by id. */
  schedules: Readonly<Record<string, string>>;
  now: number;
}): JSX.Element {
  const { t } = useI18n();
  const header = (key: SortKey, column: string) => {
    const label = sortLabel(props.sort, key, column, t);
    const dir = props.sort?.key === key ? props.sort.dir : null;
    return (
      <th scope="col" aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : "none"}>
        <button type="button" className="au-sort" data-act={`sort-${key}`} aria-label={label ?? column} onClick={() => props.onSort(key)}>
          {column}
          {dir && <> <Icon name={dir === "asc" ? "arrow-up" : "arrow-down"} size={12} /></>}
        </button>
      </th>
    );
  };
  return (
    <table className="au-table au-list" role="grid" aria-label={t("automations.list.label")}>
      <thead>
        <tr>
          {header("name", t("automations.list.col.name"))}
          <th scope="col">{t("automations.list.col.project")}</th>
          {header("lastRun", t("automations.list.col.lastRun"))}
          <th scope="col">{t("automations.list.col.status")}</th>
          <th scope="col">
            <span className="au-visually-hidden">{t("automations.list.col.actions")}</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {props.rows.map(({ automation: a, lastRun, project }) => {
          const cell = lastRunCell(lastRun, props.now, t);
          const items: MenuEntry[] = [
            { label: t("automations.actions.runNow"), onSelect: () => props.onAction(a.id, "run") },
            { label: t("automations.actions.edit"), onSelect: () => props.onAction(a.id, "edit") },
            { label: t(a.enabled ? "automations.actions.pause" : "automations.actions.resume"), onSelect: () => props.onAction(a.id, "toggle") },
            { type: "separator" },
            { label: t("automations.actions.delete"), danger: true, onSelect: () => props.onAction(a.id, "delete") },
          ];
          return (
            <tr key={a.id} className="au-row" data-act="row" data-automation={a.id} aria-selected={props.selected === a.id} onClick={() => props.onSelect(a.id)}>
              <td>
                <button type="button" className="au-link" data-act="select" onClick={() => props.onSelect(a.id)}>
                  {a.name}
                </button>
                <span className="au-sub">{props.schedules[a.id] ?? ""}</span>
              </td>
              <td>{project}</td>
              <td>
                <StatusDot state={cell.tone} label={cell.text} />
              </td>
              <td onClick={(e) => e.stopPropagation()}>
                <Switch
                  checked={a.enabled}
                  aria-label={t(a.enabled ? "automations.list.status.enabled" : "automations.list.status.paused") + ": " + a.name}
                  data-act="toggle"
                  onChange={() => props.onAction(a.id, "toggle")}
                />
                <span className="au-sub">{t(a.enabled ? "automations.list.status.enabled" : "automations.list.status.paused")}</span>
              </td>
              {/* The menu acts on the row without selecting it. */}
              <td className="au-actions" onClick={(e) => e.stopPropagation()}>
                <MenuButton label={t("automations.actions.label", { name: a.name })} items={items} className="ws-icon-btn" action="actions">
                  <Icon name="more" />
                </MenuButton>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
