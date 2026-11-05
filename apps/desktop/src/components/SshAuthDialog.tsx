import { Dialog, Field } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, SshAuthPrompt } from "@/api";
import { useI18n } from "@/i18n";

const FIELD: Record<SshAuthPrompt["kind"], string> = {
  password: "ssh.auth.password",
  passphrase: "ssh.auth.passphrase",
  confirm: "ssh.auth.confirm",
  other: "ssh.auth.other",
};

/**
 * What ssh asks for a kept connection: its prompt, one input, Cancel and Continue. A confirm (yes/no)
 * is plain text; anything else is masked. The answer lives only in this dialog until it is sent.
 */
export function SshAuthDialog(props: { prompt: SshAuthPrompt; onReply(answer: string | null): void }): JSX.Element {
  const { t } = useI18n();
  const { prompt } = props;
  const [answer, setAnswer] = useState("");
  const confirm = prompt.kind === "confirm";
  const send = (): void => props.onReply(answer);
  return (
    <Dialog
      modal
      title={t("ssh.auth.title", { alias: prompt.alias })}
      confirmLabel={t("ssh.auth.continue")}
      cancelLabel={t("ssh.auth.cancel")}
      confirmDisabled={confirm && answer.trim() === ""}
      onConfirm={send}
      onCancel={() => props.onReply(null)}
    >
      <form
        className="ssh-auth-form"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <p className="ws-mono ssh-auth-prompt" data-testid="ssh-auth-prompt">
          {prompt.prompt}
        </p>
        <Field
          label={t(FIELD[prompt.kind])}
          hint={t(confirm ? "ssh.auth.confirmHint" : "ssh.auth.hint")}
          type={confirm ? "text" : "password"}
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
      </form>
    </Dialog>
  );
}

/** The prompts waiting for an answer, first come first shown. */
export function queuePrompt(queue: readonly SshAuthPrompt[], prompt: SshAuthPrompt): SshAuthPrompt[] {
  return queue.some((p) => p.requestId === prompt.requestId) ? [...queue] : [...queue, prompt];
}

export function dropPrompt(queue: readonly SshAuthPrompt[], requestId: string): SshAuthPrompt[] {
  return queue.filter((p) => p.requestId !== requestId);
}

/** Shows each `ssh://auth-prompt` in turn and sends the reply; a prompt that ends on its own goes away. */
export function SshAuthPrompts(props: { api: Pick<Api, "onSshAuthPrompt" | "onSshAuthClosed" | "sshAuthReply"> }): JSX.Element | null {
  const { api } = props;
  const [queue, setQueue] = useState<SshAuthPrompt[]>([]);
  useEffect(() => {
    let stale = false;
    const offPrompt = api.onSshAuthPrompt((p) => !stale && setQueue((q) => queuePrompt(q, p)));
    const offClosed = api.onSshAuthClosed((id) => !stale && setQueue((q) => dropPrompt(q, id)));
    return () => {
      stale = true;
      for (const off of [offPrompt, offClosed]) void off.then((f) => f(), () => {});
    };
  }, [api]);
  const shown = queue[0];
  if (!shown) return null;
  return (
    <SshAuthDialog
      key={shown.requestId}
      prompt={shown}
      onReply={(answer) => {
        setQueue((q) => dropPrompt(q, shown.requestId));
        // A prompt that already ended (timed out, disconnected) has nothing to answer.
        api.sshAuthReply(shown.requestId, answer).catch(() => {});
      }}
    />
  );
}
