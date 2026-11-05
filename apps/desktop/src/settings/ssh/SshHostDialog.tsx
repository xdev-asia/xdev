import { Dialog, Field } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type SshHost } from "@/api";
import { useI18n } from "@/i18n";
import { formOf, hostOf, problems, type HostForm } from "./sshModel";

/** Adds a host or edits one. `others` are the aliases of the other hosts. */
export function SshHostDialog(props: {
  api: Pick<Api, "sshHostSave">;
  initial: SshHost | null;
  others: readonly string[];
  onSaved(): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const [form, setForm] = useState<HostForm>(formOf(props.initial));
  const [shown, setShown] = useState(false);
  const [failed, setFailed] = useState<string>();
  const bad = problems(form, props.others);
  const set = (key: keyof HostForm) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function save(): Promise<void> {
    setShown(true);
    setFailed(undefined);
    if (bad.alias || bad.port) return;
    try {
      await props.api.sshHostSave(hostOf(form, props.initial?.id ?? ""));
      props.onSaved();
    } catch (e) {
      setFailed(toApiError(e).code);
    }
  }

  const aliasError = shown && bad.alias ? t(bad.alias === "aliasTaken" ? "ssh.form.aliasTaken" : "ssh.form.aliasBad") : undefined;
  const portError = shown && bad.port ? t("ssh.form.portBad") : undefined;
  return (
    <Dialog
      modal
      title={t(props.initial ? "ssh.form.editTitle" : "ssh.form.newTitle")}
      confirmLabel={t("ssh.form.save")}
      cancelLabel={t("ssh.form.cancel")}
      onConfirm={() => void save()}
      onCancel={props.onCancel}
    >
      <form
        className="ssh-form"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t("ssh.form.alias")} hint={t("ssh.form.aliasHint")} error={aliasError} value={form.alias} onChange={set("alias")} placeholder="web-1" autoComplete="off" />
        <Field label={t("ssh.form.hostName")} hint={t("ssh.form.hostNameHint")} value={form.hostName} onChange={set("hostName")} placeholder="web.example.com" autoComplete="off" />
        <Field label={t("ssh.form.user")} value={form.user} onChange={set("user")} placeholder="deploy" autoComplete="off" />
        <Field label={t("ssh.form.port")} error={portError} value={form.port} onChange={set("port")} inputMode="numeric" placeholder="22" autoComplete="off" />
        <Field label={t("ssh.form.identityFile")} value={form.identityFile} onChange={set("identityFile")} placeholder="~/.ssh/id_ed25519" autoComplete="off" />
        {failed && (
          <p className="error-text" role="alert">
            {t(`error.${failed}`)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
