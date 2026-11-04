import type { JSX, ReactNode } from "react";
import type { SettingsFilter } from "./sections";

/** One searchable control; renders nothing while a search is set and this id is not a hit. */
export function SettingRow(props: { id: string; filter?: SettingsFilter; as?: "div" | "li"; className?: string; children: ReactNode }): JSX.Element | null {
  const { id, filter } = props;
  if (filter && !filter.ids.has(id)) return null;
  const Tag = props.as ?? "div";
  return (
    <Tag className={props.className} data-setting-id={id}>
      {props.children}
    </Tag>
  );
}

/** A group heading and its rows: shown when no search is set or one of the ids is a hit. */
export function SettingGroup(props: { ids: readonly string[]; filter?: SettingsFilter; children: ReactNode }): JSX.Element | null {
  const { filter } = props;
  if (filter && !props.ids.some((i) => filter.ids.has(i))) return null;
  return <>{props.children}</>;
}
