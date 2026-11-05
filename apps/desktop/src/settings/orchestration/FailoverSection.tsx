import { Button, Field, IconButton, Select, Switch } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { OrchestrationSettings } from "@/api";
import { useI18n } from "@/i18n";
import { SettingGroup, SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";

/** `FAILOVER_MAX`, `STUCK_MINUTES_MAX` and `BACKUP_AGENTS_MAX` in Rust; the page asks for at least one failover. */
export const FAILOVER_MAX = { min: 1, max: 5 } as const;
export const STUCK_MINUTES = { min: 1, max: 120 } as const;
export const BACKUP_AGENTS_MAX = 8;

/** A whole number in `min..=max` from what was typed, or null. */
export function parseWhole(text: string, min: number, max: number): number | null {
  if (!/^\s*\d+\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= min && n <= max ? n : null;
}

/** The list with the item at `at` moved one place by `by`. */
export function moved<T>(list: readonly T[], at: number, by: -1 | 1): T[] {
  const to = at + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  const [item] = next.splice(at, 1);
  next.splice(to, 0, item!);
  return next;
}

export type FailoverAgent = { id: string; name: string };

const ROW_IDS = ["orchestration.failover", "orchestration.failoverAccount", "orchestration.failoverAgents", "orchestration.failoverMax", "orchestration.autopilot"];

/**
 * Settings → Orchestration → Failover: replace a worker that fails before it finishes with the same
 * agent on another account or with a backup agent, and restart a stuck one. Off by default.
 */
export function FailoverSection(props: {
  settings: OrchestrationSettings | null;
  /** The agents a backup may be, in the order the picker lists them. */
  agents: readonly FailoverAgent[];
  /** Saves a change; resolves with whether it was stored. */
  onChange(change: Partial<OrchestrationSettings>): Promise<boolean>;
  filter?: SettingsFilter;
}): JSX.Element {
  const { settings, agents, onChange, filter } = props;
  const { t } = useI18n();
  const [maxText, setMaxText] = useState("");
  const [stuckText, setStuckText] = useState("");
  const [adding, setAdding] = useState("");
  const [note, setNote] = useState("");
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const addRow = useRef<HTMLDivElement | null>(null);
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    if (!settings) return;
    setMaxText(String(settings.failoverMax));
    setStuckText(String(settings.stuckMinutes));
  }, [settings?.failoverMax, settings?.stuckMinutes]);

  // The target is a button of the saved list, so wait until it is drawn and enabled before moving focus there.
  useEffect(() => {
    if (focus === null) return;
    const el = focus === "add" ? addRow.current?.querySelector("button") : buttons.current.get(focus);
    if (!el || el.disabled) return;
    el.focus();
    setFocus(null);
  }, [focus, settings]);

  const off = settings === null;
  const list = settings?.failoverBackupAgents ?? [];
  const name = (id: string) => agents.find((a) => a.id === id)?.name ?? id;
  const choices = agents.filter((a) => !list.includes(a.id));
  const pick = choices.some((a) => a.id === adding) ? adding : (choices[0]?.id ?? "");
  const max = parseWhole(maxText, FAILOVER_MAX.min, FAILOVER_MAX.max);
  const stuck = parseWhole(stuckText, STUCK_MINUTES.min, STUCK_MINUTES.max);

  const save = (change: Partial<OrchestrationSettings>, done = t("settings.orchestration.failover.saved")): void => {
    void onChange(change).then((ok) => {
      setNote(ok ? done : "");
      if (!ok) setFocus(null);
    });
  };

  function move(at: number, by: -1 | 1): void {
    const id = list[at]!;
    const to = at + by;
    // At an end the button just pressed goes away; keep focus on its pair.
    const dir = to === 0 ? "down" : to === list.length - 1 ? "up" : by === -1 ? "up" : "down";
    setFocus(`${id}:${dir}`);
    save({ failoverBackupAgents: moved(list, at, by) }, t("settings.orchestration.failover.moved", { name: name(id), position: to + 1 }));
  }

  function remove(at: number): void {
    const id = list[at]!;
    const next = list.filter((_, i) => i !== at);
    const after = next[Math.min(at, next.length - 1)];
    setFocus(after ? `${after}:remove` : "add");
    save({ failoverBackupAgents: next }, t("settings.orchestration.failover.removed", { name: name(id) }));
  }

  function add(): void {
    if (!pick || list.length >= BACKUP_AGENTS_MAX) return;
    setAdding("");
    save({ failoverBackupAgents: [...list, pick] }, t("settings.orchestration.failover.added", { name: name(pick), position: list.length + 1 }));
  }

  const commitMax = (): void => {
    if (settings && max !== null && max !== settings.failoverMax) save({ failoverMax: max });
  };
  const commitStuck = (): void => {
    if (settings && stuck !== null && stuck !== settings.stuckMinutes) save({ stuckMinutes: stuck });
  };
  const range = (min: number, top: number) => t("settings.orchestration.failover.rangeError", { min, max: top });

  return (
    <SettingGroup ids={ROW_IDS} filter={filter}>
    <section className="orchestration-failover" aria-labelledby="orchestration-failover-title" data-section="failover">
      <h4 className="settings-group" id="orchestration-failover-title">
        {t("settings.orchestration.failover.title")}
      </h4>
      <SettingRow id="orchestration.failover" filter={filter}>
        <Switch
          data-field="failover"
          checked={settings?.failoverEnabled ?? false}
          disabled={off}
          label={t("settings.orchestration.failover.enabled")}
          onChange={(e) => save({ failoverEnabled: e.target.checked })}
        />
        <p className="settings-empty">{t("settings.orchestration.failover.hint")}</p>
      </SettingRow>

      <SettingRow id="orchestration.failoverAccount" filter={filter}>
        <Switch
          data-field="failoverAccount"
          checked={settings?.failoverBackupAccount ?? true}
          disabled={off}
          label={t("settings.orchestration.failover.account")}
          onChange={(e) => save({ failoverBackupAccount: e.target.checked })}
        />
        <p className="settings-empty">{t("settings.orchestration.failover.accountHint")}</p>
      </SettingRow>

      <SettingRow id="orchestration.failoverAgents" filter={filter}>
        <p className="settings-empty" id="orchestration-failover-agents">
          {t("settings.orchestration.failover.agents")}
        </p>
        {list.length === 0 ? (
          <p className="settings-empty" data-field="no-backup">
            {t("settings.orchestration.failover.noAgents")}
          </p>
        ) : (
          <ol className="settings-list" aria-labelledby="orchestration-failover-agents" data-field="backup-agents">
            {list.map((id, i) => (
              <li key={id} className="settings-item" data-agent={id}>
                <div className="settings-item-text">
                  <strong>{name(id)}</strong>
                </div>
                <div className="settings-actions">
                  <IconButton
                    icon="arrow-up"
                    label={t("settings.orchestration.failover.moveUp", { name: name(id) })}
                    disabled={off || i === 0}
                    ref={(el) => void buttons.current.set(`${id}:up`, el)}
                    onClick={() => move(i, -1)}
                  />
                  <IconButton
                    icon="arrow-down"
                    label={t("settings.orchestration.failover.moveDown", { name: name(id) })}
                    disabled={off || i === list.length - 1}
                    ref={(el) => void buttons.current.set(`${id}:down`, el)}
                    onClick={() => move(i, 1)}
                  />
                  <IconButton
                    icon="close"
                    label={t("settings.orchestration.failover.remove", { name: name(id) })}
                    disabled={off}
                    ref={(el) => void buttons.current.set(`${id}:remove`, el)}
                    onClick={() => remove(i)}
                  />
                </div>
              </li>
            ))}
          </ol>
        )}
        {choices.length > 0 && list.length < BACKUP_AGENTS_MAX && (
          <div className="ws-fields orchestration-failover-add" ref={addRow}>
            <label className="ws-field">
              <span>{t("settings.orchestration.failover.addLabel")}</span>
              <Select data-field="add-agent" value={pick} disabled={off} onChange={(e) => setAdding(e.target.value)} options={choices.map((a) => ({ value: a.id, label: a.name }))} />
            </label>
            <Button type="button" variant="secondary" data-act="add-backup" disabled={off} onClick={add}>
              {t("settings.orchestration.failover.add")}
            </Button>
          </div>
        )}
      </SettingRow>

      <SettingRow id="orchestration.failoverMax" filter={filter}>
        <div className="ws-fields">
          <Field
            label={t("settings.orchestration.failover.max")}
            hint={t("settings.orchestration.failover.maxHint")}
            inputMode="numeric"
            data-field="failover-max"
            value={maxText}
            disabled={off}
            error={!off && max === null ? range(FAILOVER_MAX.min, FAILOVER_MAX.max) : undefined}
            onChange={(e) => setMaxText(e.target.value)}
            onBlur={commitMax}
            onKeyDown={(e) => e.key === "Enter" && commitMax()}
          />
        </div>
      </SettingRow>

      <SettingRow id="orchestration.autopilot" filter={filter}>
        <Switch
          data-field="autopilot"
          checked={settings?.autopilotRestart ?? false}
          disabled={off}
          label={t("settings.orchestration.failover.autopilot")}
          onChange={(e) => save({ autopilotRestart: e.target.checked })}
        />
        <p className="settings-empty">{t("settings.orchestration.failover.autopilotHint")}</p>
        <div className="ws-fields">
          <Field
            label={t("settings.orchestration.failover.stuck")}
            inputMode="numeric"
            data-field="stuck-minutes"
            value={stuckText}
            disabled={off}
            error={!off && stuck === null ? range(STUCK_MINUTES.min, STUCK_MINUTES.max) : undefined}
            onChange={(e) => setStuckText(e.target.value)}
            onBlur={commitStuck}
            onKeyDown={(e) => e.key === "Enter" && commitStuck()}
          />
        </div>
      </SettingRow>

      <p className="settings-empty" data-field="failover-terms">
        {t("settings.orchestration.failover.terms")}
      </p>
      <p className="settings-hint" role="status" data-field="failover-status">
        {note}
      </p>
    </section>
    </SettingGroup>
  );
}
