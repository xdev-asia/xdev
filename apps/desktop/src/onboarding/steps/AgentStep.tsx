import { Select } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { ProfilesView } from "@/api";
import { useI18n } from "@/i18n";
import type { Answers } from "../onboardingState";

/** Step 1: the agent a new agent tab starts and the shell a new shell tab opens. */
export function AgentStep(props: { view: ProfilesView | null; answers: Answers; onAnswer(a: Answers): void }): JSX.Element {
  const { t } = useI18n();
  const { view, answers } = props;
  if (!view) return <p className="onb-hint">{t("onboarding.loading")}</p>;
  const agent = answers.agent ?? view.defaultAgent;
  const shell = answers.shell ?? view.defaultShell;
  const agents = view.profiles.filter((p) => p.profile.enabled || p.profile.id === agent);
  return (
    <div className="ws-fields">
      <p className="onb-hint">{t("onboarding.agent.hint")}</p>
      <label className="ws-field">
        <span>{t("settings.agents.defaultAgent")}</span>
        <Select
          data-field="agent"
          value={agent}
          onChange={(e) => props.onAnswer({ agent: e.target.value })}
          options={[
            { value: "auto", label: t("settings.agents.default.auto") },
            { value: "blank", label: t("settings.agents.default.blank") },
            ...agents.map((p) => ({ value: p.profile.id, label: p.profile.name })),
          ]}
        />
      </label>
      <label className="ws-field">
        <span>{t("settings.agents.defaultShell")}</span>
        <Select data-field="shell" value={shell} onChange={(e) => props.onAnswer({ shell: e.target.value })} options={view.shells.map((s) => ({ value: s.id, label: s.name }))} />
      </label>
    </div>
  );
}
