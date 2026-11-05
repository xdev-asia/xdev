import { Button, Dialog, Field, Select } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type LaunchOverrides, type LaunchVerdict, type ProfileView } from "@/api";
import { useI18n } from "@/i18n";
import { buildOverrides, CUSTOM_MODEL, EMPTY_FORM, type OptionsForm } from "./launchOptions";
import { PromptComposer, type Need, type SkillItem } from "./PromptComposer";
import { verdictMessage } from "./verdictCopy";

/** What the dialog hands back: this launch's overrides (null for none) and a first prompt (null for none). */
export type LaunchChoice = { overrides: LaunchOverrides | null; prompt: string | null };

/**
 * The setup of one launch of an agent: model, effort, extra arguments and a first prompt. Nothing is
 * saved; the profile stays as it is. Check runs the agent's `--version` and says what came of it.
 */
export function LaunchOptionsDialog(props: {
  api: Api;
  profile: ProfileView;
  worktree: string;
  onLaunch(choice: LaunchChoice): void;
  onCancel(): void;
}): JSX.Element {
  const { api, profile, worktree } = props;
  const { t } = useI18n();
  const [form, setForm] = useState<OptionsForm>(EMPTY_FORM);
  const [prompt, setPrompt] = useState("");
  const [skills, setSkills] = useState<SkillItem[] | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [checking, setChecking] = useState(false);
  const [verdict, setVerdict] = useState<LaunchVerdict | null>(null);
  const [checkError, setCheckError] = useState<string | null>(null);
  const name = profile.profile.name;
  const hasEffort = profile.efforts.length > 0;
  const { badArgs } = buildOverrides(form, hasEffort);
  const set = (patch: Partial<OptionsForm>) => setForm((f) => ({ ...f, ...patch }));

  // Lists load once, on the first `/` or `@`; a failure leaves the list empty.
  const [wanted, setWanted] = useState<Need[]>([]);
  useEffect(() => {
    let live = true;
    if (wanted.includes("skills") && skills === null) {
      api.kitSkills(worktree).then(
        (list) => live && setSkills(list.map((s) => ({ name: s.name, description: s.description }))),
        () => live && setSkills([]),
      );
    }
    if (wanted.includes("files") && files === null) {
      api.filesList(worktree).then(
        (list) => live && setFiles(list.files),
        () => live && setFiles([]),
      );
    }
    return () => {
      live = false;
    };
  }, [api, worktree, wanted, skills, files]);

  async function check() {
    setChecking(true);
    setVerdict(null);
    setCheckError(null);
    try {
      setVerdict(await api.agentProbe(profile.profile.id));
    } catch (e) {
      setCheckError(t(`error.${toApiError(e).code}`));
    } finally {
      setChecking(false);
    }
  }

  const modelOptions = [
    { value: "", label: t("agentLaunch.model.default") },
    ...profile.models.map((m) => ({ value: m, label: m })),
    { value: CUSTOM_MODEL, label: t("agentLaunch.model.custom") },
  ];
  const effortOptions = [{ value: "", label: t("agentLaunch.effort.default") }, ...profile.efforts.map((e) => ({ value: e, label: e }))];

  return (
    <Dialog
      modal
      body="plain"
      title={t("agentLaunch.title", { agent: name })}
      confirmLabel={t("agentLaunch.launch")}
      cancelLabel={t("dialog.cancel")}
      confirmDisabled={badArgs}
      onConfirm={() => props.onLaunch({ overrides: buildOverrides(form, hasEffort).overrides, prompt: prompt.trim() === "" ? null : prompt })}
      onCancel={props.onCancel}
    >
      <div className="ws-fields agent-launch-fields">
        <label className="ws-field">
          {t("agentLaunch.model")}
          <Select options={modelOptions} value={form.model} onChange={(e) => set({ model: e.target.value })} />
        </label>
        {form.model === CUSTOM_MODEL && (
          <Field
            className="ws-mono"
            label={t("agentLaunch.model.customLabel")}
            value={form.customModel}
            spellCheck={false}
            onChange={(e) => set({ customModel: e.target.value })}
          />
        )}
        {hasEffort && (
          <label className="ws-field">
            {t("agentLaunch.effort")}
            <Select options={effortOptions} value={form.effort} onChange={(e) => set({ effort: e.target.value })} />
          </label>
        )}
        <Field
          className="ws-mono"
          label={t("agentLaunch.args")}
          hint={t("agentLaunch.args.hint")}
          error={badArgs ? t("agentLaunch.args.bad") : undefined}
          value={form.args}
          spellCheck={false}
          onChange={(e) => set({ args: e.target.value })}
        />
        <PromptComposer
          value={prompt}
          onChange={setPrompt}
          skills={skills}
          files={files}
          onNeed={(need) => setWanted((w) => (w.includes(need) ? w : [...w, need]))}
        />
        <div className="agent-launch-check">
          <Button variant="secondary" type="button" disabled={checking} onClick={() => void check()}>
            {checking ? t("agentLaunch.checking") : t("agentLaunch.check")}
          </Button>
          <span role="status" aria-live="polite">
            {verdict ? verdictMessage(t, name, verdict) : checkError}
          </span>
        </div>
      </div>
    </Dialog>
  );
}
