import { useState } from "react";
import type { JSX } from "react";
import type { CustomShell, ShellView } from "@/api";
import { useI18n } from "@/i18n";
import { freeId, lines } from "./agentForm";

// Built-in shell ids a custom one may not take.
const RESERVED = ["powershell", "cmd", "login"];

/**
 * The shells the `+` menu offers, and the owner's own ones. The view carries no program or args
 * of a custom shell, so one is changed by removing it and adding it again.
 */
export function ShellsSection(props: {
  shells: ShellView[];
  busy: boolean;
  onAdd(s: CustomShell): void;
  /** Takes the id without the `shell:` prefix. */
  onRemove(id: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const [draft, setDraft] = useState<{ name: string; program: string; args: string } | null>(null);

  function add(): void {
    if (!draft) return;
    const taken = [...RESERVED, ...props.shells.map((s) => s.id.replace(/^shell:/, ""))];
    props.onAdd({ id: freeId(draft.name, taken, "shell-custom"), name: draft.name.trim(), program: draft.program.trim(), args: lines(draft.args) });
    setDraft(null);
  }

  return (
    <>
      <h4 className="settings-group">{t("settings.agents.shells")}</h4>
      <ul className="settings-list">
        {props.shells.map((s) => (
          <li key={s.id} className="settings-item" data-shell={s.id}>
            <div className="settings-item-text">
              <strong>{s.name}</strong>
              <span className="settings-path">{t(`settings.agents.shellKind.${s.kind}`)}</span>
            </div>
            {s.custom && (
              <button
                type="button"
                className="btn-secondary"
                disabled={props.busy}
                onClick={() => props.onRemove(s.id.replace(/^shell:/, ""))}
              >
                {t("settings.agents.remove")}
              </button>
            )}
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="agent-editor" role="group" aria-label={t("settings.agents.addShell")}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.agents.name")}</span>
              <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="ws-field">
              <span>{t("settings.agents.program")}</span>
              <input className="ws-mono" value={draft.program} onChange={(e) => setDraft({ ...draft, program: e.target.value })} />
            </label>
            <label className="ws-field">
              <span>{t("settings.agents.args")}</span>
              <textarea className="ws-mono" rows={2} value={draft.args} onChange={(e) => setDraft({ ...draft, args: e.target.value })} />
              <small className="settings-hint">{t("settings.agents.argsHint")}</small>
            </label>
          </div>
          <div className="settings-actions">
            <button type="button" className="btn-secondary" onClick={() => setDraft(null)}>
              {t("settings.agents.cancel")}
            </button>
            <button
              type="button"
              className="btn-secondary"
              disabled={props.busy || !draft.name.trim() || !draft.program.trim()}
              onClick={add}
            >
              {t("settings.agents.save")}
            </button>
          </div>
        </div>
      ) : (
        <div className="settings-actions settings-actions-start">
          <button type="button" className="btn-secondary" onClick={() => setDraft({ name: "", program: "", args: "" })}>
            {t("settings.agents.addShell")}
          </button>
        </div>
      )}
    </>
  );
}
