import { Button, Field, RadioGroup, Textarea } from "@xdev-asia/ui";
import { useId, useState } from "react";
import type { FormEvent, JSX } from "react";
import type { PromptQueueQuotaFact, PromptQueueWhenInput } from "@/api";
import { useI18n } from "@/i18n";
import { resetFor, toDraft, toInput, toLocal, type WhenDraft, type WhenKind } from "./queue";
import { formatTime } from "./whenLabel";

const KINDS: readonly WhenKind[] = ["in_minutes", "at", "after_reset", "idle"];

/**
 * The schedule of a queued prompt: when it goes. Used to queue the prompt in the box, and to edit a
 * queued one (then the text is edited too).
 */
export function ScheduleForm(props: {
  /** The account of the tab it goes to, to pick its quota window. */
  account: string | null;
  quotas: readonly PromptQueueQuotaFact[];
  /** Text of the item being edited; omit to queue the prompt in the box. */
  text?: string;
  initial?: WhenDraft;
  confirmLabel: string;
  disabled?: boolean;
  onSubmit(when: PromptQueueWhenInput, text: string | undefined): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const name = useId();
  const [draft, setDraft] = useState<WhenDraft>(props.initial ?? { ...toDraft({ kind: "idle" }, Date.now()), kind: "in_minutes" });
  const [text, setText] = useState(props.text ?? "");
  const input = toInput(draft, props.account, props.quotas);
  const textOk = props.text === undefined || text.trim() !== "";
  const reset = resetFor(props.account, props.quotas);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (input && textOk && !props.disabled) props.onSubmit(input, props.text === undefined ? undefined : text);
  };

  return (
    <form className="composer-schedule" onSubmit={submit} data-testid="composer-schedule">
      {props.text !== undefined && <Textarea mono rows={4} label={t("composer.queue.text")} value={text} onChange={(e) => setText(e.target.value)} />}
      <RadioGroup
        name={name}
        orientation="vertical"
        label={t("composer.schedule.when")}
        value={draft.kind}
        onChange={(v) => setDraft({ ...draft, kind: v as WhenKind })}
        options={KINDS.map((k) => ({ value: k, label: t(`composer.schedule.${k}`) }))}
      />
      {draft.kind === "in_minutes" && (
        <Field
          label={t("composer.schedule.minutes")}
          type="number"
          inputMode="numeric"
          min={0}
          max={10080}
          step={1}
          value={draft.minutes}
          error={input === null ? t("composer.schedule.minutes.error") : undefined}
          onChange={(e) => setDraft({ ...draft, minutes: e.target.value })}
        />
      )}
      {draft.kind === "at" && (
        <Field
          label={t("composer.schedule.at.label")}
          type="datetime-local"
          value={draft.at}
          min={toLocal(Date.now())}
          error={input === null ? t("composer.schedule.at.error") : undefined}
          onChange={(e) => setDraft({ ...draft, at: e.target.value })}
        />
      )}
      {draft.kind === "after_reset" && (
        <p className="composer-hint" data-testid="composer-reset-hint">
          {reset.resetAt === null ? t("composer.schedule.after_reset.unknown") : t("composer.schedule.after_reset.known", { time: formatTime(reset.resetAt) })}
        </p>
      )}
      {draft.kind === "idle" && <p className="composer-hint">{t("composer.schedule.idle.hint")}</p>}
      <div className="composer-actions">
        <Button type="button" variant="secondary" onClick={props.onCancel}>
          {t("dialog.cancel")}
        </Button>
        <Button variant="primary" type="submit" icon="clock" disabled={!input || !textOk || !!props.disabled}>
          {props.confirmLabel}
        </Button>
      </div>
    </form>
  );
}
