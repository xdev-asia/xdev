import { Button, Dialog, Field, IconButton, Select } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type SequenceStep, type SetEntry, type StartupPreset, type TerminalSet } from "@/api";
import { useI18n } from "@/i18n";
import { newSet, blankEntry, entrySummary } from "./sets";
import { StepsEditor, stepsValid } from "./StepsEditor";
import { TERMINAL_SET_LIMITS } from "./limits";

/** A running tab, as the dialog lists it for "Save as preset". */
export interface RunningTab {
  id: string;
  title: string;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The text of an upsert's rejection, in the UI's language. */
export function saveError(t: T, e: unknown): string {
  const err = toApiError(e);
  const detail = (err.detail ?? "").toLowerCase();
  if (err.code !== "bad_arg") return t(`error.${err.code}`);
  for (const key of ["name", "entries", "profile", "command", "wait", "steps", "worktree", "list"]) {
    if (detail.includes(key)) return t(`terminalSets.error.${key}`);
  }
  return t("terminalSets.error.other");
}

/** Edits one set: its name and each entry's kind, target, worktree and startup steps. */
function SetEditor(props: {
  api: Api;
  set: TerminalSet;
  agents: readonly { id: string; label: string }[];
  worktrees: readonly string[];
  presets: readonly StartupPreset[];
  onBack(): void;
  onSaved(name: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const [name, setName] = useState(props.set.name);
  const [entries, setEntries] = useState<SetEntry[]>(props.set.entries);
  const [error, setError] = useState<string | null>(null);
  const patch = (i: number, next: SetEntry) => setEntries((es) => es.map((e, k) => (k === i ? next : e)));
  const agentOptions = (current: string) => {
    const list = props.agents.map((a) => ({ value: a.id, label: a.label }));
    return list.some((o) => o.value === current) ? list : [{ value: current, label: current }, ...list];
  };
  const valid =
    name.trim() !== "" &&
    entries.length >= 1 &&
    entries.every(
      (e) =>
        stepsValid(e.startup) &&
        (e.worktree.type !== "named" || e.worktree.name.trim() !== "") &&
        (e.target.type !== "agent" || e.target.profile !== ""),
    );

  async function save() {
    setError(null);
    try {
      const saved = await props.api.terminalSetUpsert({ ...props.set, name: name.trim(), entries });
      props.onSaved(saved.name);
    } catch (e) {
      setError(saveError(t, e));
    }
  }

  return (
    <Dialog
      modal
      body="plain"
      title={t("terminalSets.editTitle")}
      confirmLabel={t("terminalSets.saveChanges")}
      cancelLabel={t("terminalSets.back")}
      confirmDisabled={!valid}
      onConfirm={() => void save()}
      onCancel={props.onBack}
    >
      <div className="ws-fields ts-editor">
        <Field label={t("terminalSets.name")} value={name} maxLength={TERMINAL_SET_LIMITS.name} onChange={(e) => setName(e.target.value)} />
        {entries.map((entry, i) => (
          <fieldset key={i} className="ts-entry">
            <legend>{t("terminalSets.entry.title", { n: i + 1 })}</legend>
            <label className="ws-field">
              {t("terminalSets.entry.kind")}
              <Select
                options={[
                  { value: "agent", label: t("terminalSets.entry.kind.agent") },
                  { value: "shell", label: t("terminalSets.entry.kind.shell") },
                ]}
                value={entry.target.type}
                onChange={(e) =>
                  patch(i, {
                    ...entry,
                    target: e.target.value === "agent" ? { type: "agent", profile: props.agents[0]?.id ?? "" } : { type: "shell", command: "", shell: null },
                  })
                }
              />
            </label>
            {entry.target.type === "agent" ? (
              <label className="ws-field">
                {t("terminalSets.entry.agent")}
                <Select
                  options={agentOptions(entry.target.profile)}
                  value={entry.target.profile}
                  onChange={(e) => patch(i, { ...entry, target: { type: "agent", profile: e.target.value } })}
                />
              </label>
            ) : (
              <Field
                className="ws-mono"
                label={t("terminalSets.entry.command")}
                hint={t("terminalSets.entry.command.hint")}
                value={entry.target.command}
                spellCheck={false}
                onChange={(e) => {
                  if (entry.target.type !== "shell") return;
                  patch(i, { ...entry, target: { ...entry.target, command: e.target.value } });
                }}
              />
            )}
            <label className="ws-field">
              {t("terminalSets.entry.worktree")}
              <Select
                options={[
                  { value: "", label: t("terminalSets.entry.worktree.current") },
                  ...(entry.worktree.type === "named" && !props.worktrees.includes(entry.worktree.name)
                    ? [{ value: entry.worktree.name, label: t("terminalSets.entry.worktree.missing", { name: entry.worktree.name }) }]
                    : []),
                  ...props.worktrees.map((w) => ({ value: w, label: w })),
                ]}
                value={entry.worktree.type === "named" ? entry.worktree.name : ""}
                onChange={(e) => patch(i, { ...entry, worktree: e.target.value === "" ? { type: "current" } : { type: "named", name: e.target.value } })}
              />
            </label>
            <StepsEditor steps={entry.startup} presets={props.presets} onChange={(startup) => patch(i, { ...entry, startup })} />
            <div className="ts-row">
              <Button variant="secondary" type="button" disabled={entries.length <= 1} onClick={() => setEntries((es) => es.filter((_, k) => k !== i))}>
                {t("terminalSets.entry.remove", { n: i + 1 })}
              </Button>
            </div>
          </fieldset>
        ))}
        <div className="ts-row">
          <Button
            variant="secondary"
            type="button"
            disabled={entries.length >= TERMINAL_SET_LIMITS.entries}
            onClick={() => setEntries((es) => [...es, blankEntry(props.agents[0]?.id ?? null)])}
          >
            {t("terminalSets.entry.add")}
          </Button>
        </div>
        <span role="alert" className="ts-error">
          {error}
        </span>
      </div>
    </Dialog>
  );
}

/**
 * The sets of this window: open, rename, edit and delete them, save the open tabs as one, and save a
 * running tab's startup sequence as a preset. Changes are announced in a status line.
 */
export function TerminalSetsDialog(props: {
  api: Api;
  sets: readonly TerminalSet[];
  presets: readonly StartupPreset[];
  /** Agents an entry can run. */
  agents: readonly { id: string; label: string }[];
  /** Names of the worktrees an entry can name. */
  worktrees: readonly string[];
  running: readonly RunningTab[];
  /** Startup sequence of each running tab, for "Save as preset". */
  startupOf(tabId: string): readonly SequenceStep[];
  /** What "Save current tabs as set" would store. */
  capture(): SetEntry[];
  onOpen(set: TerminalSet): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { api } = props;
  const [name, setName] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<TerminalSet | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [presetName, setPresetName] = useState<Record<string, string>>({});
  const captured = props.capture();

  async function run(work: () => Promise<string>) {
    setError(null);
    try {
      setNote(await work());
    } catch (e) {
      setError(saveError(t, e));
    }
  }

  if (editing) {
    return (
      <SetEditor
        api={api}
        set={editing}
        agents={props.agents}
        worktrees={props.worktrees}
        presets={props.presets}
        onBack={() => setEditing(null)}
        onSaved={(n) => {
          setEditing(null);
          setNote(t("terminalSets.saved", { name: n }));
        }}
      />
    );
  }

  return (
    <Dialog modal body="plain" title={t("terminalSets.title")} confirmLabel={t("terminalSets.done")} cancelLabel={null} onConfirm={props.onClose} onCancel={props.onClose}>
      <div className="ws-fields ts-dialog">
        <section aria-label={t("terminalSets.title")}>
          {props.sets.length === 0 ? (
            <p className="ts-hint">{t("terminalSets.empty")}</p>
          ) : (
            <ul className="ts-list">
              {props.sets.map((s) => (
                <li key={s.id} className="ts-item">
                  {renaming?.id === s.id ? (
                    <form
                      className="ts-row"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void run(async () => {
                          const saved = await api.terminalSetUpsert({ ...s, name: renaming.name.trim() });
                          setRenaming(null);
                          return t("terminalSets.saved", { name: saved.name });
                        });
                      }}
                    >
                      <Field
                        label={t("terminalSets.renameLabel", { name: s.name })}
                        value={renaming.name}
                        maxLength={TERMINAL_SET_LIMITS.name}
                        onChange={(e) => setRenaming({ id: s.id, name: e.target.value })}
                      />
                      <Button variant="secondary" type="submit" disabled={renaming.name.trim() === ""}>
                        {t("terminalSets.rename")}
                      </Button>
                      <Button variant="secondary" type="button" onClick={() => setRenaming(null)}>
                        {t("terminalSets.back")}
                      </Button>
                    </form>
                  ) : (
                    <>
                      <div className="ts-item-main">
                        <strong>{s.name}</strong>
                        <span className="ts-hint">
                          {t("terminalSets.entries", { count: s.entries.length })}
                          {" · "}
                          {s.entries.map((e) => entrySummary(e, t("terminalSets.entry.plainShell"))).join(", ")}
                        </span>
                      </div>
                      {deleting === s.id ? (
                        <div className="ts-row">
                          <span>{t("terminalSets.delete.confirm", { name: s.name })}</span>
                          <Button
                            variant="secondary"
                            type="button"
                            onClick={() =>
                              void run(async () => {
                                await api.terminalSetDelete(s.id);
                                setDeleting(null);
                                return "";
                              })
                            }
                          >
                            {t("terminalSets.delete")}
                          </Button>
                          <Button variant="secondary" type="button" onClick={() => setDeleting(null)}>
                            {t("terminalSets.delete.keep")}
                          </Button>
                        </div>
                      ) : (
                        <div className="ts-row">
                          <Button variant="secondary" type="button" aria-label={t("terminalSets.openLabel", { name: s.name })} onClick={() => props.onOpen(s)}>
                            {t("terminalSets.open")}
                          </Button>
                          <IconButton icon="edit" label={t("terminalSets.editLabel", { name: s.name })} onClick={() => setEditing(s)} />
                          <Button
                            variant="secondary"
                            type="button"
                            aria-label={t("terminalSets.renameLabel", { name: s.name })}
                            onClick={() => setRenaming({ id: s.id, name: s.name })}
                          >
                            {t("terminalSets.rename")}
                          </Button>
                          <IconButton icon="trash" label={t("terminalSets.deleteLabel", { name: s.name })} onClick={() => setDeleting(s.id)} />
                        </div>
                      )}
                    </>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
        <form
          className="ts-row"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              const saved = await api.terminalSetUpsert(newSet(name, captured));
              setName("");
              return t("terminalSets.saved", { name: saved.name });
            });
          }}
        >
          <Field
            label={t("terminalSets.saveName")}
            value={name}
            maxLength={TERMINAL_SET_LIMITS.name}
            hint={captured.length === 0 ? t("terminalSets.noTabs") : undefined}
            onChange={(e) => setName(e.target.value)}
          />
          <Button variant="secondary" type="submit" disabled={name.trim() === "" || captured.length === 0}>
            {t("terminalSets.saveCurrent")}
          </Button>
        </form>
        <section aria-label={t("terminalSets.running.title")}>
          <h3 className="ts-h">{t("terminalSets.running.title")}</h3>
          <p className="ts-hint">{t("terminalSets.running.hint")}</p>
          <ul className="ts-list">
            {props.running.map((r) => {
              const steps = props.startupOf(r.id);
              return (
                <li key={r.id} className="ts-item">
                  <div className="ts-item-main">
                    <strong>{r.title}</strong>
                    {steps.length === 0 && <span className="ts-hint">{t("terminalSets.running.none")}</span>}
                  </div>
                  {steps.length > 0 && (
                    <div className="ts-row">
                      <Field
                        label={t("terminalSets.startup.presetName")}
                        value={presetName[r.id] ?? ""}
                        maxLength={TERMINAL_SET_LIMITS.name}
                        onChange={(e) => setPresetName((m) => ({ ...m, [r.id]: e.target.value }))}
                      />
                      <Button
                        variant="secondary"
                        type="button"
                        aria-label={t("terminalSets.running.save", { name: r.title })}
                        disabled={(presetName[r.id] ?? "").trim() === ""}
                        onClick={() =>
                          void run(async () => {
                            const saved = await api.startupPresetUpsert({ id: "", name: (presetName[r.id] ?? "").trim(), steps: structuredClone([...steps]) });
                            setPresetName((m) => ({ ...m, [r.id]: "" }));
                            return t("terminalSets.startup.presetSaved", { name: saved.name });
                          })
                        }
                      >
                        {t("terminalSets.startup.savePreset")}
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
        <section aria-label={t("terminalSets.startup.presetsTitle")}>
          <h3 className="ts-h">{t("terminalSets.startup.presetsTitle")}</h3>
          {props.presets.length === 0 ? (
            <p className="ts-hint">{t("terminalSets.startup.presetsEmpty")}</p>
          ) : (
            <ul className="ts-list">
              {props.presets.map((p) => (
                <li key={p.id} className="ts-item ts-row">
                  <strong>{p.name}</strong>
                  <IconButton
                    icon="trash"
                    label={t("terminalSets.startup.deletePreset", { name: p.name })}
                    onClick={() =>
                      void run(async () => {
                        await api.startupPresetDelete(p.id);
                        return "";
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </section>
        <span role="status" aria-live="polite" className="ts-hint">
          {note}
        </span>
        <span role="alert" className="ts-error">
          {error}
        </span>
      </div>
    </Dialog>
  );
}
