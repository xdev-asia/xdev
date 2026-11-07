import type { JSX, ReactNode } from "react";
import { SettingRow as UiSettingRow } from "@xdev-asia/ui";
import type { SettingsFilter } from "./sections";

/** Whether a control shows: always without a search, else only when its id is a hit. */
export function settingShown(filter: SettingsFilter | undefined, id: string): boolean {
  return !filter || filter.ids.has(id);
}

interface SettingRowProps {
  id: string;
  filter?: SettingsFilter;
  /** Given: the row draws as the design system's SettingRow (label and hint left, `control` right). Left out: `children` is the markup, wrapped and tagged with the id. */
  label?: ReactNode;
  description?: ReactNode;
  control?: ReactNode;
  controlId?: string;
  children?: ReactNode;
}

/**
 * One searchable control; renders nothing while a search is set and this id is not a hit. The
 * design system's SettingRow carries the layout when `label` is given.
 */
export function SettingRow(props: SettingRowProps): JSX.Element | null {
  if (!settingShown(props.filter, props.id)) return null;
  if (props.label !== undefined) {
    return <UiSettingRow id={props.id} label={props.label} description={props.description} control={props.control} controlId={props.controlId} />;
  }
  return <div data-setting-id={props.id}>{props.children}</div>;
}

/** A group heading and its rows: shown when no search is set or one of the ids is a hit. */
export function SettingGroup(props: { ids: readonly string[]; filter?: SettingsFilter; children: ReactNode }): JSX.Element | null {
  const { filter } = props;
  if (filter && !props.ids.some((i) => filter.ids.has(i))) return null;
  return <>{props.children}</>;
}

type Target = { scrollIntoView?(o: { block: ScrollLogicalPosition }): void; classList: { add(c: string): void; remove(c: string): void } };

export const FLASH_CLASS = "setting-flash";
const GIVE_UP_MS = 3000;
const FLASH_MS = 1600;

/**
 * Scrolls the control the palette asked for into view and flashes it once. It resolves the control
 * by id right away. A page that is still loading has not drawn the row yet, so `watch` is asked to
 * call again when the page changes (a DOM observer, not a timer poll); the watch stops at the first
 * hit, or after 3 s. Returns a function that stops everything.
 */
export function revealSetting(find: () => Target | null, watch?: (notify: () => void) => () => void): () => void {
  let flash: ReturnType<typeof setTimeout> | undefined;
  let giveUp: ReturnType<typeof setTimeout> | undefined;
  let unwatch: (() => void) | undefined;
  let done = false;
  const stopWatching = (): void => {
    clearTimeout(giveUp);
    unwatch?.();
    unwatch = undefined;
  };
  const look = (): void => {
    if (done) return;
    const el = find();
    if (!el) return;
    done = true;
    stopWatching();
    el.scrollIntoView?.({ block: "center" });
    el.classList.add(FLASH_CLASS);
    flash = setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
  };
  look();
  if (!done && watch) {
    unwatch = watch(look);
    giveUp = setTimeout(stopWatching, GIVE_UP_MS);
  }
  return () => {
    done = true;
    stopWatching();
    clearTimeout(flash);
  };
}
