import { useState } from "react";
import type { JSX } from "react";
import { Button } from "@xdev-asia/ui";
import { useProfiles } from "@/agents/profileStore";
import { useI18n } from "@/i18n";
import { targetItems } from "./AgentTargetMenu";
import type { SendChoice } from "./agentPrompt";
import type { AckSummary } from "./fixAgent";
import type { Sessions } from "./sessions";

/** The result of one send: whether the agent got the prompt, and what the acknowledgement did. */
export interface SendOutcome {
  ok: boolean;
  summary: AckSummary | null;
}

/**
 * The queue's footer: "Send N to agent", the agent menu, and the option to resolve and reply on
 * GitHub afterwards. The option starts off, because it writes to GitHub.
 */
export function PrSendBar(props: {
  sessions: Sessions | null | undefined;
  worktree: string;
  count: number;
  onSend: (choice: SendChoice, ack: boolean) => Promise<SendOutcome>;
  onClear: () => void;
  /** Seeds, for the tests. */
  initialOpen?: boolean;
  initialSummary?: AckSummary | null;
}): JSX.Element {
  const { sessions, worktree, count, onSend } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [open, setOpen] = useState(props.initialOpen ?? false);
  const [ack, setAck] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "failed">("idle");
  const [summary, setSummary] = useState<AckSummary | null>(props.initialSummary ?? null);

  async function send(choice: SendChoice): Promise<void> {
    if (!sessions || count === 0 || state === "sending") return;
    setOpen(false);
    setState("sending");
    setSummary(null);
    try {
      const out = await onSend(choice, ack);
      setState(out.ok ? "idle" : "failed");
      setSummary(out.summary);
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="ws-prc-send">
      {count > 0 && (
        <>
          <Button
            type="button"
            variant="secondary"
            aria-haspopup="menu"
            aria-expanded={open}
            disabled={!sessions || state === "sending"}
            onClick={() => setOpen(!open)}
          >
            {t(count === 1 ? "prc.send.agent.one" : "prc.send.agent", { count })}
          </Button>
          <Button type="button" variant="secondary" disabled={state === "sending"} onClick={props.onClear}>
            {t("prc.send.clear")}
          </Button>
        </>
      )}
      {open && (
        <div className="rv-base-menu ws-prc-send-menu" role="menu" aria-label={t("prc.send.title")}>
          <label className="rv-check">
            <input type="checkbox" checked={ack} onChange={() => setAck(!ack)} />
            <span>{t("prc.send.ack")}</span>
          </label>
          {targetItems(sessions, worktree, view, t, (choice) => void send(choice))}
        </div>
      )}
      {state === "failed" && (
        <span className="error-text" role="alert">
          {t("prc.send.failed")}
        </span>
      )}
      {summary && (
        <span className="ws-prc-summary" role="status">
          {t("prc.send.summary", { ...summary })}
        </span>
      )}
    </div>
  );
}
