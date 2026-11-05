import type { JSX, KeyboardEvent } from "react";
import { IconButton } from "@xdev-asia/ui";
import { settingShown } from "./SettingRow";
import type { SettingsFilter } from "./sections";
import type { AppId } from "@/shell/apps";

/** Which control of a part row has focus; a move keeps focus on the same kind. */
export type PartControl = "switch" | "up" | "down";

/** `order` with `id` moved by `delta` places (-1 up, 1 down); the same array when it cannot move. */
export function moveApp(order: readonly AppId[], id: AppId, delta: -1 | 1): readonly AppId[] {
  const from = order.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= order.length) return order;
  const next = [...order];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/** The move an Alt+Arrow key asks for; `null` for any other key. */
export function moveFromKey(e: Pick<KeyboardEvent, "key" | "altKey" | "ctrlKey" | "metaKey" | "shiftKey">): -1 | 1 | null {
  if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return null;
  if (e.key === "ArrowUp") return -1;
  if (e.key === "ArrowDown") return 1;
  return null;
}

/** Puts focus back on a control of a part row once the list has been redrawn. */
export function focusPart(id: AppId, control: PartControl): void {
  if (typeof document === "undefined") return;
  document.querySelector<HTMLElement>(`[data-switch="app-${id}"] [data-part-control="${control}"]`)?.focus();
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Settings → Appearance → Workspace parts: every activity bar part with a switch and move buttons, in the
 * order the bar shows them, and the reset button. Alt+Arrow Up or Down on a row moves it too.
 */
export function WorkspaceParts(props: {
  order: readonly AppId[];
  hidden: readonly string[];
  busy: boolean;
  filter?: SettingsFilter;
  t: T;
  /** A line for screen readers about the last change; empty for none. */
  note: string;
  onToggle(id: AppId): void;
  onMove(id: AppId, delta: -1 | 1, control: PartControl): void;
  onReset(): void;
}): JSX.Element {
  const { order, hidden, busy, filter, t } = props;
  const lastShown = (id: AppId) => !hidden.includes(id) && order.filter((a) => !hidden.includes(a)).length <= 1;
  const control = (el: EventTarget | null): PartControl => {
    const kind = (el as { dataset?: { partControl?: string } } | null)?.dataset?.partControl;
    return kind === "up" || kind === "down" ? kind : "switch";
  };
  return (
    <>
      <ul className="settings-list" aria-label={t("settings.parts.title")}>
        {order.map((id, i) => {
          const shown = !hidden.includes(id);
          const name = t(`apps.${id}`);
          return (
            settingShown(filter, `appearance.app.${id}`) && (
              <li
                className="settings-item"
                data-switch={`app-${id}`}
                data-setting-id={`appearance.app.${id}`}
                key={id}
                onKeyDown={(e) => {
                  const delta = moveFromKey(e);
                  if (delta === null || busy) return;
                  e.preventDefault();
                  props.onMove(id, delta, control(e.target));
                }}
              >
                <div className="settings-item-text">
                  <strong>{name}</strong>
                </div>
                <IconButton
                  icon="arrow-up"
                  label={t("settings.parts.up", { app: name })}
                  data-part-control="up"
                  aria-disabled={busy || i === 0}
                  onClick={() => !busy && i > 0 && props.onMove(id, -1, "up")}
                />
                <IconButton
                  icon="arrow-down"
                  label={t("settings.parts.down", { app: name })}
                  data-part-control="down"
                  aria-disabled={busy || i === order.length - 1}
                  onClick={() => !busy && i < order.length - 1 && props.onMove(id, 1, "down")}
                />
                <button
                  type="button"
                  role="switch"
                  className="agent-switch"
                  data-part-control="switch"
                  aria-checked={shown}
                  aria-label={t("settings.appearance.app.show", { app: name })}
                  disabled={busy || lastShown(id)}
                  onClick={() => props.onToggle(id)}
                />
              </li>
            )
          );
        })}
      </ul>
      <small className="settings-hint">{t("settings.parts.hint")}</small>
      <div className="settings-actions">
        <button type="button" className="btn-secondary" data-act="parts-reset" disabled={busy} onClick={props.onReset}>
          {t("settings.parts.reset")}
        </button>
      </div>
      <span role="status" className="x-sr-only" data-testid="parts-status">
        {props.note}
      </span>
    </>
  );
}
