import { useState } from "react";
import type { JSX } from "react";
import { Dialog, RadioGroup, Select } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";

/** What the next agent is given: a focused summary, or the conversation text itself. */
export type HandOffContent = "summary" | "full";

export interface HandOffChoice {
  profileId: string;
  worktree: string;
  /** Set only when the dialog offers the choice. */
  content?: HandOffContent;
}

export interface HandOffOption {
  value: string;
  label: string;
}

/** The first choice: an agent other than the source when there is one, in the source's worktree. */
export function defaultHandOff(profiles: HandOffOption[], sourceProfile: string, sourceWorktree: string): HandOffChoice {
  const other = profiles.find((p) => p.value !== sourceProfile) ?? profiles[0];
  return { profileId: other?.value ?? sourceProfile, worktree: sourceWorktree };
}

export interface HandOffViewProps {
  choice: HandOffChoice;
  profiles: HandOffOption[];
  worktrees: HandOffOption[];
  onChoice(choice: HandOffChoice): void;
  onConfirm(choice: HandOffChoice): void;
  onCancel(): void;
}

/** Hand off to another agent: pick the agent and the worktree. One primary button (Hand off). */
export function HandOffView(props: HandOffViewProps): JSX.Element {
  const { t } = useI18n();
  const { choice } = props;
  return (
    <Dialog title={t("agentFork.handOff.title")} confirmLabel={t("agentFork.handOff.confirm")} cancelLabel={t("agentFork.handOff.cancel")} onConfirm={() => props.onConfirm(choice)} onCancel={props.onCancel}>
      <span className="ws-handoff-field">
        <label htmlFor="ws-handoff-profile">{t("agentFork.handOff.agent")}</label>
        <Select id="ws-handoff-profile" options={props.profiles} value={choice.profileId} onChange={(e) => props.onChoice({ ...choice, profileId: e.target.value })} />
      </span>
      <span className="ws-handoff-field">
        <label htmlFor="ws-handoff-worktree">{t("agentFork.handOff.worktree")}</label>
        <Select id="ws-handoff-worktree" options={props.worktrees} value={choice.worktree} onChange={(e) => props.onChoice({ ...choice, worktree: e.target.value })} />
      </span>
      {choice.content !== undefined && (
        <RadioGroup
          name="ws-handoff-content"
          label={t("agentSessions.handOff.content")}
          orientation="vertical"
          value={choice.content}
          onChange={(value) => props.onChoice({ ...choice, content: value as HandOffContent })}
          options={[
            { value: "summary", label: t("agentSessions.handOff.summary"), hint: t("agentSessions.handOff.summary.hint") },
            { value: "full", label: t("agentSessions.handOff.full"), hint: t("agentSessions.handOff.full.hint") },
          ]}
        />
      )}
    </Dialog>
  );
}

/** The stateful dialog; mounted only while open. */
export function HandOffDialog(props: {
  profiles: HandOffOption[];
  worktrees: HandOffOption[];
  sourceProfile: string;
  sourceWorktree: string;
  /** Offer "Focused summary" or "Full transcript"; the choice comes back as `content`. */
  contentChoice?: boolean;
  onConfirm(choice: HandOffChoice): void;
  onCancel(): void;
}): JSX.Element {
  const [choice, setChoice] = useState<HandOffChoice>(() => {
    const first = defaultHandOff(props.profiles, props.sourceProfile, props.sourceWorktree);
    return props.contentChoice ? { ...first, content: "summary" } : first;
  });
  return <HandOffView choice={choice} profiles={props.profiles} worktrees={props.worktrees} onChoice={setChoice} onConfirm={props.onConfirm} onCancel={props.onCancel} />;
}
