import { Button, Tag } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Account, ApiError, Profile, ProfileView } from "@/api";
import { useI18n } from "@/i18n";
import { accountsFor, draftOf, profileOf, type Draft } from "./agentForm";

/**
 * The inline editor of one profile; `view` is null for a new custom profile.
 * `onSave` gets the profile to store; a field that cannot be read stops it here.
 */
export function ProfileEditor(props: {
  view: ProfileView | null;
  /** The id a new custom profile gets; ignored for an existing one. */
  newId: string;
  accounts: Account[];
  busy: boolean;
  error?: ApiError["code"];
  onSave(p: Profile): void;
  onReset(id: string): void;
  onRemove(id: string): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const base = props.view?.profile ?? null;
  const [draft, setDraft] = useState<Draft>(() => draftOf(base));
  const [local, setLocal] = useState<ApiError["code"]>();
  const builtin = base !== null && base.cli !== null;
  const efforts = props.view?.efforts ?? [];
  const accounts = accountsFor(props.view, props.accounts);
  const error = local ?? props.error;
  // The modes the agent offers; a stored mode it no longer offers stays listed so the field still reads true.
  const modes: string[] = ["", ...(props.view?.modes ?? [])];
  if (draft.permissions !== "" && !modes.includes(draft.permissions)) modes.push(draft.permissions);
  // What the agent runs as: the field, else what the global switch gives it.
  const effective = draft.permissions !== "" ? draft.permissions : (props.view?.permissions ?? "ask");
  const flagged = builtin && !(props.view?.customArgs ?? false) && effective !== "ask";

  const set = (key: keyof Draft) => (e: { target: { value: string } }) => {
    const value = e.target.value;
    setDraft((d) => ({ ...d, [key]: value }));
  };

  function save(): void {
    const profile = profileOf(draft, base, base?.id ?? props.newId);
    if (!profile) {
      setLocal("invalid_profile");
      return;
    }
    setLocal(undefined);
    props.onSave(profile);
  }

  return (
    <div className="agent-editor" role="group" aria-label={t("settings.agents.editTitle", { name: base?.name ?? t("settings.agents.newProfile") })}>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.agents.name")}</span>
          <input value={draft.name} onChange={set("name")} />
        </label>
        {!builtin && (
          <label className="ws-field">
            <span>{t("settings.agents.program")}</span>
            <input className="ws-mono" value={draft.program} onChange={set("program")} />
          </label>
        )}
        <label className="ws-field">
          <span>{t("settings.agents.model")}</span>
          <input className="ws-mono" value={draft.model} onChange={set("model")} placeholder={t("settings.agents.modelDefault")} />
        </label>
        {efforts.length > 0 && (
          <label className="ws-field">
            <span>{t("settings.agents.effort")}</span>
            <select value={draft.effort} onChange={set("effort")}>
              <option value="">{t("settings.agents.effortDefault")}</option>
              {efforts.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
          </label>
        )}
        {builtin && (
          <label className="ws-field">
            <span>{t("settings.agents.permissions")}</span>
            <select value={draft.permissions} onChange={set("permissions")} data-field="permissions">
              {modes.map((p) => (
                <option key={p} value={p}>
                  {t(`settings.agents.perm.${p || "follow"}`)}
                </option>
              ))}
            </select>
          </label>
        )}
        {builtin && props.view?.customArgs && <small className="settings-hint">{t("settings.agents.perm.customHint")}</small>}
        {flagged && (
          <div>
            <Tag
              onRemove={() => setDraft((d) => ({ ...d, permissions: "ask" }))}
              removeLabel={t("settings.agents.perm.remove", { flag: t(`settings.agents.perm.${effective}`), agent: base?.name ?? "" })}
            >
              {t(`settings.agents.perm.${effective}`)}
            </Tag>
          </div>
        )}
        {(base?.cli === "claude" || base?.cli === "codex") && (
          <label className="ws-field">
            <span>{t("settings.agents.account")}</span>
            <select value={draft.account} onChange={set("account")} data-field="account">
              <option value="">{t("settings.agents.accountDefault")}</option>
              {accounts.map((a) => (
                <option key={a.name} value={a.name}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="ws-field">
          <span>{t("settings.agents.args")}</span>
          <textarea className="ws-mono" rows={3} value={draft.args} onChange={set("args")} data-field="args" />
          <small className="settings-hint">{t("settings.agents.argsHint")}</small>
        </label>
        <label className="ws-field">
          <span>{t("settings.agents.env")}</span>
          <textarea className="ws-mono" rows={3} value={draft.env} onChange={set("env")} data-field="env" />
          <small className="settings-hint">{t("settings.agents.envHint")}</small>
        </label>
        <label className="ws-field">
          <span>{t("settings.agents.startup")}</span>
          <textarea className="ws-mono" rows={3} value={draft.startup} onChange={set("startup")} data-field="startup" />
          <small className="settings-hint">{t("settings.agents.startupHint")}</small>
        </label>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <div className="settings-actions">
        {builtin && (
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={() => props.onReset(base.id)}>
            {t("settings.agents.reset")}
          </button>
        )}
        {base !== null && !builtin && (
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={() => props.onRemove(base.id)}>
            {t("settings.agents.remove")}
          </button>
        )}
        <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onCancel}>
          {t("settings.agents.cancel")}
        </button>
        <Button type="button" disabled={props.busy} onClick={save}>
          {t("settings.agents.save")}
        </Button>
      </div>
    </div>
  );
}
