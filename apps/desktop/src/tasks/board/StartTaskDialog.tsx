import { Dialog, RadioGroup, Select } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { BoardTask } from "@/api";
import { useI18n } from "@/i18n";
import type { StartWhere } from "./boardModel";
import "@/styles/board.css";

export interface StartTaskDialogProps {
  task?: BoardTask;
  agents: { value: string; label: string }[];
  /** The agent chosen at first: the task's assignee, else the default agent. */
  defaultAgent: string | null;
  /** Whether a worktree is on screen to run in. */
  hasCurrent: boolean;
  busy?: boolean;
  onStart(where: StartWhere, agent: string | null): void;
  onClose(): void;
}

/** Asks where the agent runs and which agent; one primary button, Start. */
export function StartTaskDialog(props: StartTaskDialogProps): JSX.Element {
  const { t } = useI18n();
  const [where, setWhere] = useState<StartWhere>("new");
  const known = props.agents.some((a) => a.value === props.defaultAgent);
  const [agent, setAgent] = useState<string>(known ? (props.defaultAgent as string) : (props.agents[0]?.value ?? ""));
  return (
    <Dialog
      modal
      title={t("board.start.title")}
      confirmLabel={t("board.start.go")}
      cancelLabel={t("dialog.cancel")}
      confirmDisabled={props.busy || (where === "current" && !props.hasCurrent)}
      onConfirm={() => props.onStart(where, agent || null)}
      onCancel={props.onClose}
    >
      <form
        className="board-start-form"
        onSubmit={(e) => {
          e.preventDefault();
          props.onStart(where, agent || null);
        }}
      >
        <RadioGroup
          name="board-start-where"
          orientation="vertical"
          label={t("board.start.where")}
          value={where}
          onChange={(v) => setWhere(v as StartWhere)}
          options={[
            { value: "new", label: t("board.start.newWorktree") },
            { value: "current", label: t("board.start.current"), disabled: !props.hasCurrent, hint: props.hasCurrent ? undefined : t("board.start.noCurrent") },
          ]}
        />
        <label className="ws-field">
          {t("board.start.agent")}
          <Select name="agent" value={agent} onChange={(e) => setAgent(e.target.value)} options={props.agents} />
        </label>
      </form>
    </Dialog>
  );
}
