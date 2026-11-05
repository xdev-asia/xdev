import { Checkbox, Dialog, Disclosure, Field, Textarea } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type SshHost } from "@/api";
import { useI18n } from "@/i18n";
import { ADVANCED_FIELDS, formOf, hasAdvanced, hostOf, problems, type HostForm, type ProblemField } from "./sshModel";

const MESSAGE: Record<ProblemField, string> = {
  alias: "ssh.form.aliasBad",
  port: "ssh.form.portBad",
  proxyJump: "ssh.form.proxyJumpBad",
  forwards: "ssh.form.forwardsBad",
  connectTimeout: "ssh.form.connectTimeoutBad",
  extraOptions: "ssh.form.extraOptionsBad",
};

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
  const [advanced, setAdvanced] = useState(() => hasAdvanced(formOf(props.initial)));
  const [failed, setFailed] = useState<string>();
  const bad = problems(form, props.others);
  const set = (key: Exclude<keyof HostForm, "forwardAgent">) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value });

  async function save(): Promise<void> {
    setShown(true);
    setFailed(undefined);
    if (Object.keys(bad).length > 0) {
      if (ADVANCED_FIELDS.some((f) => bad[f])) setAdvanced(true);
      return;
    }
    try {
      await props.api.sshHostSave(hostOf(form, props.initial?.id ?? ""));
      props.onSaved();
    } catch (e) {
      setFailed(toApiError(e).code);
    }
  }

  const error = (field: ProblemField): string | undefined => {
    const problem = shown ? bad[field] : undefined;
    if (!problem) return undefined;
    return t(problem === "aliasTaken" ? "ssh.form.aliasTaken" : MESSAGE[field]);
  };
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
        <Field label={t("ssh.form.alias")} hint={t("ssh.form.aliasHint")} error={error("alias")} value={form.alias} onChange={set("alias")} placeholder="web-1" autoComplete="off" />
        <Field label={t("ssh.form.hostName")} hint={t("ssh.form.hostNameHint")} value={form.hostName} onChange={set("hostName")} placeholder="web.example.com" autoComplete="off" />
        <Field label={t("ssh.form.user")} value={form.user} onChange={set("user")} placeholder="deploy" autoComplete="off" />
        <Field label={t("ssh.form.port")} error={error("port")} value={form.port} onChange={set("port")} inputMode="numeric" placeholder="22" autoComplete="off" />
        <Field label={t("ssh.form.identityFile")} value={form.identityFile} onChange={set("identityFile")} placeholder="~/.ssh/id_ed25519" autoComplete="off" />
        <Disclosure className="ssh-form-advanced" title={t("ssh.form.advanced")} expanded={advanced} onToggle={setAdvanced}>
          <Field
            label={t("ssh.form.proxyJump")}
            hint={t("ssh.form.proxyJumpHint")}
            error={error("proxyJump")}
            value={form.proxyJump}
            onChange={set("proxyJump")}
            placeholder="me@bastion:22"
            autoComplete="off"
          />
          <Checkbox
            label={t("ssh.form.forwardAgent")}
            hint={t("ssh.form.forwardAgentHint")}
            checked={form.forwardAgent}
            onChange={(e) => setForm({ ...form, forwardAgent: e.target.checked })}
          />
          <Textarea
            label={t("ssh.form.forwards")}
            hint={t("ssh.form.forwardsHint")}
            error={error("forwards")}
            mono
            rows={2}
            value={form.forwards}
            onChange={set("forwards")}
            placeholder="5432:db.internal:5432"
          />
          <Field
            label={t("ssh.form.connectTimeout")}
            hint={t("ssh.form.connectTimeoutHint")}
            error={error("connectTimeout")}
            value={form.connectTimeout}
            onChange={set("connectTimeout")}
            inputMode="numeric"
            placeholder="10"
            autoComplete="off"
          />
          <Textarea
            label={t("ssh.form.extraOptions")}
            hint={t("ssh.form.extraOptionsHint")}
            error={error("extraOptions")}
            mono
            rows={2}
            value={form.extraOptions}
            onChange={set("extraOptions")}
            placeholder="ServerAliveInterval=30"
          />
        </Disclosure>
        {failed && (
          <p className="error-text" role="alert">
            {t(`error.${failed}`)}
          </p>
        )}
      </form>
    </Dialog>
  );
}
