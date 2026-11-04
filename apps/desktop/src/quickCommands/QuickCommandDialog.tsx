import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { Api, QuickCommand } from "@/api";
import { useI18n } from "@/i18n";
import { canSave, counterOf, draftOf, emptyDraft, saveDraft, type Counter, type Draft, type Field } from "./form";
import { QUICK_COMMAND_LIMITS } from "./limits";

export interface RepoChoice {
  /** The repo registry key (its path). */
  path: string;
  name: string;
}

export interface ProfileChoice {
  id: string;
  name: string;
}

function CounterText(props: { c: Counter | null }): JSX.Element | null {
  const { t } = useI18n();
  const { c } = props;
  if (!c) return null;
  const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
  return (
    <span className="qc-counter" data-over={c.used > c.max || undefined}>
      {c.bytes ? `${kib(c.used)} / ${kib(c.max)}` : t("qcmd.dialog.counter", { used: c.used, max: c.max })}
    </span>
  );
}

/**
 * New or edit quick command: Label, Scope, Type, then the command (and "Press Enter after") or the
 * agent and its prompt. A refusal from the store shows under its field. Mounted only while open.
 */
export function QuickCommandDialog(props: {
  api: Pick<Api, "quickCommandUpsert">;
  /** The command being edited; null for a new one. */
  initial: QuickCommand | null;
  /** The repo on screen: the default scope of a new command; null for global. */
  defaultRepo: string | null;
  repos: RepoChoice[];
  profiles: ProfileChoice[];
  onSaved(saved: QuickCommand): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const firstProfile = props.profiles[0]?.id ?? "";
  const [draft, setDraft] = useState<Draft>(() => (props.initial ? draftOf(props.initial, firstProfile) : emptyDraft(props.defaultRepo, firstProfile)));
  const [error, setError] = useState<{ field: Field | null; code: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  const set = (patch: Partial<Draft>) => {
    setError(null);
    setDraft((d) => ({ ...d, ...patch }));
  };

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (busy || !canSave(draft)) return;
    setBusy(true);
    const res = await saveDraft(props.api, draft, props.initial?.id ?? "");
    setBusy(false);
    if (res.ok) props.onSaved(res.saved);
    else setError({ field: res.field, code: res.code });
  }

  const under = (field: Field): JSX.Element | null =>
    error?.field === field ? (
      <span className="settings-error" role="alert">
        {t(`qcmd.error.${field}`)}
      </span>
    ) : null;

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog qc-dialog"
      aria-labelledby="qc-dialog-heading"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="qc-dialog-heading" className="dialog-title">
          {t(props.initial ? "qcmd.dialog.editTitle" : "qcmd.dialog.newTitle")}
        </h2>

        <label className="qc-field">
          <span>{t("qcmd.dialog.label")}</span>
          <input type="text" autoFocus value={draft.label} onChange={(e) => set({ label: e.target.value })} />
          <CounterText c={counterOf(draft, "label")} />
          {under("label")}
        </label>

        <fieldset className="qc-field qc-choice">
          <legend>{t("qcmd.dialog.scope")}</legend>
          <label>
            <input type="radio" name="qc-scope" checked={draft.scope === "global"} onChange={() => set({ scope: "global" })} />
            {t("qcmd.dialog.scopeGlobal")}
          </label>
          <label>
            <input
              type="radio"
              name="qc-scope"
              checked={draft.scope === "repo"}
              onChange={() => set({ scope: "repo", repo: draft.repo || props.defaultRepo || props.repos[0]?.path || "" })}
            />
            {t("qcmd.dialog.scopeRepo")}
          </label>
          {draft.scope === "repo" && (
            <select aria-label={t("qcmd.dialog.repo")} value={draft.repo} onChange={(e) => set({ repo: e.target.value })}>
              {draft.repo !== "" && !props.repos.some((r) => r.path === draft.repo) && <option value={draft.repo}>{draft.repo}</option>}
              {props.repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          {under("repo")}
        </fieldset>

        <fieldset className="qc-field qc-choice">
          <legend>{t("qcmd.dialog.type")}</legend>
          <label>
            <input type="radio" name="qc-type" checked={draft.type === "terminal"} onChange={() => set({ type: "terminal" })} />
            {t("qcmd.dialog.typeTerminal")}
          </label>
          <label>
            <input type="radio" name="qc-type" checked={draft.type === "agent"} onChange={() => set({ type: "agent" })} />
            {t("qcmd.dialog.typeAgent")}
          </label>
        </fieldset>

        {draft.type === "terminal" ? (
          <>
            <label className="qc-field">
              <span>{t("qcmd.dialog.command")}</span>
              <textarea className="ws-mono" rows={4} value={draft.command} onChange={(e) => set({ command: e.target.value })} />
              <CounterText c={counterOf(draft, "command")} />
              {under("command")}
            </label>
            <label className="qc-check">
              <input type="checkbox" checked={draft.appendEnter} onChange={(e) => set({ appendEnter: e.target.checked })} />
              {t("qcmd.dialog.enter")}
            </label>
          </>
        ) : (
          <>
            <label className="qc-field">
              <span>{t("qcmd.dialog.agent")}</span>
              <select value={draft.profile} onChange={(e) => set({ profile: e.target.value })}>
                {draft.profile !== "" && !props.profiles.some((p) => p.id === draft.profile) && <option value={draft.profile}>{draft.profile}</option>}
                {props.profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              {under("profile")}
            </label>
            <label className="qc-field">
              <span>{t("qcmd.dialog.prompt")}</span>
              <textarea rows={6} value={draft.prompt} onChange={(e) => set({ prompt: e.target.value })} />
              <CounterText c={counterOf(draft, "prompt")} />
              {under("prompt")}
              {under("prompts")}
            </label>
          </>
        )}

        {error && error.field === null && (
          <p className="error-text" role="alert">
            {t(`error.${error.code}`)}
          </p>
        )}
        <p className="settings-hint">{t("qcmd.dialog.limits", { label: QUICK_COMMAND_LIMITS.label, command: QUICK_COMMAND_LIMITS.command })}</p>
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={busy || !canSave(draft)}>
            {t("qcmd.dialog.save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
