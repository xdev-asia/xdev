import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { Button, FieldMessage, Segmented, Select, Textarea } from "@xdev-asia/ui";
import { type Api, type Automation, type ExtraArgsError, type RepoView, type ScheduleProblem, toApiError } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { ExtraArgsField } from "./ExtraArgsField";
import { GraceField } from "./GraceField";
import { MenuButton } from "./MenuButton";
import { PrecheckFields } from "./PrecheckFields";
import { SchedulePicker } from "./SchedulePicker";
import { applyTemplate, blankDraft, buildInput, draftOf, extraArgsErrorOf, localTimezone, problemMessage, problemOf, type Agent, type EditorDraft } from "./editorModel";
import { TEMPLATES, templateById, type AutomationTemplate } from "./templates";

/** How long a typed cron rests before the backend is asked about it. */
const CRON_DEBOUNCE_MS = 250;

/** Create or edit an automation: the prompt on the left, its settings in the sidebar. */
export function AutomationEditorDialog(props: {
  api: Api;
  repos: readonly RepoView[];
  agents: readonly Agent[];
  /** The agent a new automation starts with. */
  defaultAgent: string;
  /** The project a new automation starts with. */
  defaultRepo: string;
  /** The automation being edited; null creates one. */
  automation: Automation | null;
  /** A template a new automation starts from. */
  template?: AutomationTemplate | null;
  onSaved(a: Automation): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, automation } = props;
  const dialog = useRef<HTMLDialogElement>(null);
  const [draft, setDraft] = useState<EditorDraft>(() => {
    if (automation) return draftOf(automation);
    const blank = blankDraft({ repoId: props.defaultRepo, agent: props.defaultAgent });
    return props.template ? applyTemplate(blank, props.template, t) : blank;
  });
  const [cronError, setCronError] = useState<ScheduleProblem | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [extraError, setExtraError] = useState<ExtraArgsError | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const timezone = automation?.timezone ?? localTimezone();

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // The custom cron is checked by the backend once typing rests; an answer for older text is dropped.
  const cron = draft.schedule.preset === "custom" ? draft.schedule.cron : null;
  useEffect(() => {
    if (cron === null || cron.trim() === "") return void setCronError(null);
    let stale = false;
    const timer = setTimeout(() => {
      void api
        .automationValidateSchedule(cron, timezone)
        .then((key) => !stale && setCronError(key))
        .catch(() => !stale && setCronError({ key: "invalid", field: null, max: null }));
    }, CRON_DEBOUNCE_MS);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [api, cron, timezone]);

  const set = (patch: Partial<EditorDraft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    if ("extraArgs" in patch || "agent" in patch) setExtraError(null);
  };
  const repo = props.repos.find((r) => r.id === draft.repoId) ?? null;
  const worktrees = repo?.worktrees ?? [];
  const problem = problemOf(draft, { repos: props.repos, agents: props.agents, cronError, extraArgsError: extraError });
  const conflict = draft.extraArgs.trim() !== "" && draft.reuseSession && draft.mode === "existing";

  async function save(): Promise<void> {
    setAttempted(true);
    // A problem in Advanced is shown there: open it, in case it is collapsed.
    if (problem === "freshSession" || problem === "extraArgs") setAdvanced(true);
    if (problem !== null || saving) return;
    setSaving(true);
    const input = buildInput(draft, { timezone, dtstart: automation?.dtstart ?? Date.now(), enabled: automation?.enabled ?? true, defaultName: t("automations.defaultName") });
    try {
      const saved = automation ? await api.automationUpdate(automation.id, input) : await api.automationCreate(input);
      pushToast({ text: t(automation ? "automations.toast.updated" : "automations.toast.saved") });
      props.onSaved(saved);
    } catch (e) {
      const refused = extraArgsErrorOf(e);
      if (refused) {
        setExtraError(refused);
        setAdvanced(true);
      }
      else pushToast({ text: t("automations.toast.saveFailed", { code: toApiError(e).code }) });
      setSaving(false);
    }
  }

  const templateItems = TEMPLATES.map((tpl) => ({
    label: t(`automations.templates.${tpl.id}.label`),
    onSelect: () => setDraft((d) => applyTemplate(d, templateById(tpl.id)!, t)),
  }));

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog au-editor"
      aria-labelledby="au-editor-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 id="au-editor-title" className="dialog-title">
          {t(automation ? "automations.editor.titleEdit" : "automations.editor.titleCreate")}
        </h2>
        <div className="au-editor-body">
          <div className="au-editor-main">
            <div className="au-editor-name">
              <label className="ws-field">
                <span>{t("automations.editor.name")}</span>
                <input type="text" value={draft.name} placeholder={t("automations.editor.name.placeholder")} data-act="name" onChange={(e) => set({ name: e.target.value })} />
              </label>
              <MenuButton label={t("automations.editor.useTemplate")} items={templateItems} className="btn-secondary" action="use-template" placement="bottom-end" />
            </div>
            <Textarea
              label={t("automations.editor.prompt")}
              value={draft.prompt}
              placeholder={t("automations.editor.prompt.placeholder")}
              rows={10}
              data-act="prompt"
              onChange={(e) => set({ prompt: e.target.value })}
            />
          </div>
          <div className="au-editor-side ws-fields">
            <label className="ws-field">
              <span>{t("automations.editor.project")}</span>
              <Select
                value={draft.repoId}
                data-act="project"
                options={[{ value: "", label: t("automations.editor.project.choose") }, ...props.repos.filter((r) => !r.missing).map((r) => ({ value: r.id, label: r.shortName }))]}
                onChange={(e) => set({ repoId: e.target.value, worktree: "" })}
              />
            </label>
            <div className="ws-field" role="group" aria-label={t("automations.editor.location")}>
              <span>{t("automations.editor.location")}</span>
              <Segmented
                label={t("automations.editor.location")}
                options={[
                  { value: "existing", label: t("automations.editor.location.worktree") },
                  { value: "new_per_run", label: t("automations.editor.location.newRun") },
                ]}
                value={draft.mode}
                onChange={(value) => set({ mode: value as EditorDraft["mode"] })}
              />
              <small className="settings-hint">{t(draft.mode === "existing" ? "automations.editor.location.help.worktree" : "automations.editor.location.help.newRun")}</small>
            </div>
            {draft.mode === "existing" ? (
              <label className="ws-field">
                <span>{t("automations.editor.workspace")}</span>
                <Select
                  value={draft.worktree}
                  data-act="workspace"
                  options={[{ value: "", label: t("automations.editor.workspace.choose") }, ...worktrees.map((w) => ({ value: w.path, label: w.title ?? w.branch ?? w.name }))]}
                  onChange={(e) => set({ worktree: e.target.value })}
                />
              </label>
            ) : (
              <label className="ws-field">
                <span>{t("automations.editor.branchFrom")}</span>
                <input
                  type="text"
                  className="ws-mono"
                  value={draft.baseBranch}
                  placeholder={t("automations.editor.branchFrom.default")}
                  spellCheck={false}
                  data-act="branch-from"
                  onChange={(e) => set({ baseBranch: e.target.value })}
                />
              </label>
            )}
            <label className="ws-field">
              <span>{t("automations.editor.agent")}</span>
              <Select
                value={draft.agent}
                data-act="agent"
                options={[{ value: "", label: t("automations.editor.agent.choose") }, ...props.agents.filter((a) => a.enabled && a.installed).map((a) => ({ value: a.id, label: a.name }))]}
                onChange={(e) => set({ agent: e.target.value })}
              />
            </label>
            {draft.mode === "existing" && (
              <div className="ws-field" role="group" aria-label={t("automations.editor.session")}>
                <span>{t("automations.editor.session")}</span>
                <Segmented
                  label={t("automations.editor.session")}
                  options={[
                    { value: "reuse", label: t("automations.editor.session.reuse") },
                    { value: "fresh", label: t("automations.editor.session.fresh") },
                  ]}
                  value={draft.reuseSession ? "reuse" : "fresh"}
                  onChange={(value) => set({ reuseSession: value === "reuse" })}
                />
                <small className="settings-hint">{t(draft.reuseSession ? "automations.editor.session.help.reuse" : "automations.editor.session.help.fresh")}</small>
              </div>
            )}
            <SchedulePicker draft={draft.schedule} onChange={(schedule) => set({ schedule })} cronError={cronError} timezone={timezone} />
            <GraceField value={draft.grace} onChange={(grace) => set({ grace })} />
            <PrecheckFields command={draft.precheckCommand} timeout={draft.precheckTimeout} onChange={(p) => set({ precheckCommand: p.command, precheckTimeout: p.timeout })} />
            <details className="au-advanced" open={advanced} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
              <summary>{t("automations.editor.advanced")}</summary>
              <ExtraArgsField value={draft.extraArgs} conflict={conflict} error={extraError} onChange={(extraArgs) => set({ extraArgs })} onUseFresh={() => set({ reuseSession: false })} />
              {draft.mode === "new_per_run" && (
                <label className="ws-field">
                  <span>{t("automations.editor.setup")}</span>
                  <Select
                    value={draft.setup}
                    data-act="setup"
                    options={(["inherit", "run", "skip"] as const).map((v) => ({ value: v, label: t(`automations.editor.setup.${v}`) }))}
                    onChange={(e) => set({ setup: e.target.value as EditorDraft["setup"] })}
                  />
                </label>
              )}
            </details>
          </div>
        </div>
        {attempted && problem !== null && (
          <FieldMessage tone="error" id="au-editor-problem">
            {problemMessage(problem, t)}
          </FieldMessage>
        )}
        <div className="dialog-actions">
          <p className="au-note">{t("automations.editor.note")}</p>
          <button type="button" className="btn-secondary" data-act="cancel" onClick={props.onCancel}>
            {t("automations.editor.cancel")}
          </button>
          <Button type="submit" data-act="save" disabled={saving}>
            {t(automation ? "automations.editor.save" : "automations.editor.create")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
