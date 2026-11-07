import { Badge, Button, IconButton, Kbd, RadioGroup, Select } from "@xdev-asia/ui";
import { useId, useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { describeKeys, TRANSLATED_LABELS, type Question } from "./questions";
import { questionLive, useQuestion } from "./questionStore";

/** More options than this are a select, as the RadioGroup rules ask. */
const RADIO_MAX = 5;

export interface QuestionCardProps {
  question: Question;
  /** The agent's name, as the tab shows it. */
  agentName: string;
  /** Writes `keys` to the tab's pty; resolves false when it could not. */
  onSend: (keys: string) => Promise<boolean>;
  /** Gives the keyboard to the terminal, for a prompt answered there. */
  onOpenTerminal: () => void;
  /** Hides a question read from the transcript; absent for a hook question. */
  onDismiss?: () => void;
}

type T = (key: string, vars?: Record<string, string | number>) => string;

function label(t: T, text: string): string {
  return TRANSLATED_LABELS.has(text) ? t(`conversation.question.${text}`) : text;
}

/** The keys an answer types, as key caps: the text, then Enter or Escape. */
function keysPreview(keys: string, t: T): JSX.Element {
  const k = describeKeys(keys);
  return (
    <span className="cv-ask-keys">
      {k.text && <Kbd>{k.text}</Kbd>}
      {k.enter && <Kbd>{t("conversation.question.key.enter")}</Kbd>}
      {k.escape && <Kbd>{t("conversation.question.key.escape")}</Kbd>}
    </span>
  );
}

/**
 * The question an agent waits on, with its options. Picking an option sends nothing: the answer and the
 * keys it types are shown, and only Confirm writes them. A prompt this view cannot answer for sure points
 * to the terminal.
 */
export function QuestionCard(props: QuestionCardProps): JSX.Element {
  const { question: q, agentName } = props;
  const { t } = useI18n();
  const id = useId();
  const [picked, setPicked] = useState("0");
  const [confirming, setConfirming] = useState(false);
  const [sending, setSending] = useState(false);
  const [failed, setFailed] = useState(false);
  // Back from the confirm step: the send button takes the focus again.
  const [back, setBack] = useState(false);

  const choice = q.choices[Number(picked)] ?? null;
  const title =
    q.kind === "permission"
      ? t("conversation.question.title.permission", { name: agentName })
      : q.choices.length === 0
        ? t("conversation.question.title.waiting", { name: agentName })
        : t("conversation.question.title", { name: agentName });

  async function send(): Promise<void> {
    if (!choice || sending) return;
    setSending(true);
    setFailed(false);
    const ok = await props.onSend(choice.keys).catch(() => false);
    setSending(false);
    if (!ok) {
      setFailed(true);
      setConfirming(false);
    }
  }

  const options = q.choices.map((c, i) => ({ value: String(i), label: label(t, c.label), ...(c.description ? { hint: c.description } : {}) }));

  return (
    <section className="cv-ask" role="group" aria-labelledby={`${id}-title`} data-kind={q.kind} data-source={q.source} data-testid="question-card">
      <div className="cv-ask-head">
        <h3 className="cv-ask-title" id={`${id}-title`}>
          {title}
        </h3>
        {q.header && <Badge status="neutral">{q.header}</Badge>}
        {props.onDismiss && <IconButton icon="close" label={t("conversation.question.dismiss")} onClick={props.onDismiss} />}
      </div>
      {q.kind === "permission" && q.tool && <p className="cv-ask-text">{t("conversation.question.permission", { tool: q.tool })}</p>}
      {q.toolInput && <code className="cv-ask-input">{q.toolInput}</code>}
      {q.text && <p className="cv-ask-text">{q.text}</p>}
      {q.source === "transcript" && <p className="cv-ask-note">{t("conversation.question.fromText")}</p>}

      {q.answerable && q.choices.length > 0 ? (
        confirming && choice ? (
          <div className="cv-ask-confirm">
            <p className="cv-ask-note">{t("conversation.question.confirm.title", { name: agentName, answer: label(t, choice.label) })}</p>
            <p className="cv-ask-sends">
              <span>{t("conversation.question.sends")}</span> {keysPreview(choice.keys, t)}
            </p>
            <div className="cv-ask-actions">
              <Button variant="primary" type="button" autoFocus disabled={sending} onClick={() => void send()} data-testid="question-confirm">
                {t("conversation.question.confirm.send")}
              </Button>
              <Button
                type="button"
                variant="secondary"
                disabled={sending}
                onClick={() => {
                  setConfirming(false);
                  setBack(true);
                }}
              >
                {t("conversation.question.cancel")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {options.length <= RADIO_MAX ? (
              <RadioGroup
                name={`${id}-answer`}
                label={t("conversation.question.options")}
                orientation="vertical"
                options={options}
                value={picked}
                onChange={(v) => {
                  setPicked(v);
                  setFailed(false);
                }}
              />
            ) : (
              <label className="cv-ask-select">
                <span>{t("conversation.question.options")}</span>
                <Select options={options.map((o) => ({ value: o.value, label: o.label }))} value={picked} onChange={(e) => setPicked(e.currentTarget.value)} />
              </label>
            )}
            {choice && (
              <p className="cv-ask-sends">
                <span>{t("conversation.question.sends")}</span> {keysPreview(choice.keys, t)}
              </p>
            )}
            <div className="cv-ask-actions">
              <Button variant="primary" type="button" autoFocus={back} disabled={!choice} onClick={() => setConfirming(true)} data-testid="question-send">
                {t("conversation.question.send")}
              </Button>
              <Button type="button" variant="secondary" onClick={props.onOpenTerminal}>
                {t("conversation.question.terminal")}
              </Button>
            </div>
          </>
        )
      ) : (
        <>
          <p className="cv-ask-note">{t("conversation.question.fallback")}</p>
          <div className="cv-ask-actions">
            <Button variant="primary" type="button" onClick={props.onOpenTerminal} data-testid="question-terminal">
              {t("conversation.question.openTerminal")}
            </Button>
          </div>
        </>
      )}
      {failed && (
        <p className="cv-ask-error" role="alert">
          {t("conversation.question.failed")}
        </p>
      )}
    </section>
  );
}

/** The small "question" mark on a tab whose agent waits on a question. */
export function QuestionBadge({ tab }: { tab: { id: string; agent: boolean; status: string } }): JSX.Element | null {
  const { t } = useI18n();
  const q = useQuestion(tab.id);
  if (!tab.agent || !q || !questionLive(q, tab.status)) return null;
  return (
    <span className="cv-tab-question" data-testid="tab-question">
      <Badge status="changed">{t("conversation.question.badge")}</Badge>
    </span>
  );
}
