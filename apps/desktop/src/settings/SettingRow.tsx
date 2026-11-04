import type { JSX, ReactNode } from "react";
import type { SettingsFilter } from "./sections";

/** Whether a control shows: always without a search, else only when its id is a hit. */
export function settingShown(filter: SettingsFilter | undefined, id: string): boolean {
  return !filter || filter.ids.has(id);
}

/** One searchable control; renders nothing while a search is set and this id is not a hit. */
export function SettingRow(props: { id: string; filter?: SettingsFilter; children: ReactNode }): JSX.Element | null {
  if (!settingShown(props.filter, props.id)) return null;
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
const POLL_MS = 100;
const GIVE_UP_MS = 3000;
const FLASH_MS = 1600;

/**
 * Scrolls the control the palette asked for into view and flashes it once. The page may still be
 * loading, so it looks again every 100 ms for 3 s. Returns a function that stops the look.
 */
export function revealSetting(find: () => Target | null): () => void {
  let waited = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const look = (): void => {
    const el = find();
    if (el) {
      el.scrollIntoView?.({ block: "center" });
      el.classList.add(FLASH_CLASS);
      timer = setTimeout(() => el.classList.remove(FLASH_CLASS), FLASH_MS);
      return;
    }
    waited += POLL_MS;
    if (waited <= GIVE_UP_MS) timer = setTimeout(look, POLL_MS);
  };
  look();
  return () => clearTimeout(timer);
}
