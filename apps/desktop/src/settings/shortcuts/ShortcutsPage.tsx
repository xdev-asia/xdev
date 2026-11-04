import { useCallback, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type KeySettings } from "@/api";
import { useI18n } from "@/i18n";
import { setKeybindingsText, setKeySettings, useBindings } from "@/keys/bindingsStore";
import { serializeKeybindings } from "@/keys/keybindingsFile";
import type { ActionId } from "@/keys/keymap";
import type { ShortcutGroup } from "@/keys/registry";
import type { SettingsSectionProps } from "@/settings/sections";
import { ShortcutRecorder, type RecorderClash } from "./ShortcutRecorder";
import {
  addChord, buildRows, clashes, countRows, disableAction, filterRows, FILTERS, removeChord, resetAction,
  type ShortcutFilter, type ShortcutRow,
} from "./shortcutsModel";

const GROUPS: ShortcutGroup[] = ["tabs", "panes", "worktrees", "agents", "terminal", "view", "panels", "docs", "editor", "app"];

/** Settings → Shortcuts: every action with its chords, edited into `keybindings.json`. */
export function ShortcutsPage(props: SettingsSectionProps): JSX.Element {
  const { api, arg: initialQuery } = props;
  const { t } = useI18n();
  const state = useBindings();
  const [query, setQuery] = useState(initialQuery ?? "");
  const [chip, setChip] = useState<ShortcutFilter>("all");
  const [editing, setEditing] = useState<ActionId | null>(null);
  const [clash, setClash] = useState<(RecorderClash & { chord: string }) | null>(null);
  const [error, setError] = useState<ApiError["code"]>();

  const title = (id: ActionId) => t(`keys.action.${id}`);
  const rows = buildRows(state);
  const shown = filterRows(rows, query, chip, (d) => t(d.titleKey));
  const counts = countRows(rows);
  // Editing a file this page cannot read would overwrite what the person wrote by hand.
  const unreadable = state.diagnostics.some((d) => d.kind === "parse");

  async function write(next: Map<ActionId, string[]>): Promise<void> {
    setError(undefined);
    const text = serializeKeybindings(next, state.text ?? undefined);
    try {
      await api.keybindingsWrite(text);
      setKeybindingsText(text);
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  async function putSettings(next: KeySettings): Promise<void> {
    setError(undefined);
    try {
      setKeySettings(await api.keySettingsPut(next));
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  const stopEditing = useCallback(() => {
    setEditing(null);
    setClash(null);
  }, []);

  function pick(id: ActionId, chord: string): void {
    const holders = clashes(rows, id, chord);
    if (holders.length > 0) {
      setClash({ chord, titles: holders.map(title) });
      return;
    }
    stopEditing();
    void write(addChord(state.overrides, rows, id, chord, false));
  }

  function line(row: ShortcutRow): JSX.Element {
    const id = row.def.id;
    const locked = row.def.fixed === true || unreadable;
    return (
      <li key={id} className="keys-row" data-action={id} data-conflict={row.conflict || undefined}>
        <div className="keys-row-main">
          <span className="keys-title">
            {t(row.def.titleKey)}
            {row.modified && <span className="settings-tag">{t("keys.page.modified")}</span>}
            {(row.def.scope === "terminal" || row.def.yieldsToTerminal) && <span className="settings-tag">{t("keys.page.terminalBadge")}</span>}
          </span>
          <span className="keys-chords">
            {row.chords.length === 0 && <span className="settings-empty">{t("keys.page.none")}</span>}
            {row.chords.map((chord) => (
              <span key={chord} className="keys-chord">
                <kbd>{chord}</kbd>
                {!locked && (
                  <button
                    type="button"
                    className="keys-chord-x"
                    aria-label={t("keys.page.remove", { chord })}
                    onClick={() => void write(removeChord(state.overrides, rows, id, chord))}
                  >
                    ×
                  </button>
                )}
              </span>
            ))}
          </span>
          {!locked && (
            <span className="keys-actions">
              <button type="button" className="btn-secondary" onClick={() => { setClash(null); setEditing(id); }}>
                {t("keys.page.add")}
              </button>
              {row.disabled ? (
                <button type="button" className="btn-secondary" onClick={() => void write(resetAction(state.overrides, id))}>
                  {t("keys.page.enable")}
                </button>
              ) : (
                row.chords.length > 0 && (
                  <button type="button" className="btn-secondary" onClick={() => void write(disableAction(state.overrides, id))}>
                    {t("keys.page.disable")}
                  </button>
                )
              )}
              {row.modified && !row.disabled && (
                <button type="button" className="btn-secondary" onClick={() => void write(resetAction(state.overrides, id))}>
                  {t("keys.page.reset")}
                </button>
              )}
            </span>
          )}
        </div>
        {editing === id && (
          <ShortcutRecorder
            clash={clash}
            onChord={(chord) => pick(id, chord)}
            onClear={() => {
              stopEditing();
              void write(disableAction(state.overrides, id));
            }}
            onReplace={() => {
              if (!clash) return;
              const chord = clash.chord;
              stopEditing();
              void write(addChord(state.overrides, rows, id, chord, true));
            }}
            onCancel={stopEditing}
          />
        )}
      </li>
    );
  }

  return (
    <div className="settings-page keys-page">
      <header className="settings-head">
        <h3>{t("keys.title")}</h3>
        <p>{t("keys.page.intro")}</p>
      </header>

      <div className="settings-row keys-file">
        <span className="settings-path">{state.path || t("keys.page.noFile")}</span>
        <button type="button" className="btn-secondary" onClick={() => void api.keybindingsReveal().catch((e) => setError(toApiError(e).code))}>
          {t("keys.page.editFile")}
        </button>
      </div>

      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {state.diagnostics.length > 0 && (
        <ul className="keys-diagnostics" aria-label={t("keys.page.problems")}>
          {state.diagnostics.map((d, i) => (
            <li key={i} className="keys-diagnostic" data-kind={d.kind}>
              {d.message}
            </li>
          ))}
        </ul>
      )}
      {unreadable && <p className="error-text">{t("keys.page.fixFirst")}</p>}

      <h4 className="settings-group">{t("keys.page.terminal")}</h4>
      <div className="settings-card keys-policy">
        <div role="radiogroup" aria-label={t("keys.page.policy")} className="segmented">
          {(["app-first", "terminal-first"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={state.keySettings.terminalPolicy === p}
              onClick={() => void putSettings({ ...state.keySettings, terminalPolicy: p })}
            >
              {t(p === "app-first" ? "keys.page.appFirst" : "keys.page.terminalFirst")}
            </button>
          ))}
        </div>
        <small className="settings-hint">{t("keys.page.policyHint")}</small>
        <label className="keys-switch">
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={state.keySettings.terminalHints}
            aria-label={t("keys.page.hints")}
            onClick={() => void putSettings({ ...state.keySettings, terminalHints: !state.keySettings.terminalHints })}
          />
          <span>{t("keys.page.hints")}</span>
        </label>
      </div>

      <div className="keys-tools">
        <input
          type="search"
          className="keys-search"
          value={query}
          placeholder={t("keys.page.search")}
          aria-label={t("keys.page.search")}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="keys-chips" role="group" aria-label={t("keys.page.filter")}>
          {FILTERS.map((f) => (
            <button key={f} type="button" className="btn-secondary keys-chip" aria-pressed={chip === f} onClick={() => setChip(f)}>
              {t(`keys.page.filter.${f}`)} <span className="keys-count">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      {shown.length === 0 && <p className="settings-empty">{t("keys.page.empty")}</p>}
      {GROUPS.map((g) => {
        const inGroup = shown.filter((r) => r.def.group === g);
        if (inGroup.length === 0) return null;
        return (
          <section key={g} className="keys-group" aria-label={t(`keys.group.${g}`)}>
            <h4 className="settings-group">{t(`keys.group.${g}`)}</h4>
            <ul className="settings-list keys-list">{inGroup.map(line)}</ul>
          </section>
        );
      })}
    </div>
  );
}
