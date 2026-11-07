import { Button, LaunchCard, type LaunchValue } from "@xdev-asia/ui";
import { useRef, useState } from "react";
import type { JSX } from "react";
import { useI18n } from "@/i18n";

/** One agent the page can start, with the models its profile knows. */
export interface NewTabAgent {
  id: string;
  name: string;
  models: readonly string[];
}

/**
 * The page of a worktree with no tab yet: a launch card for the agents (agent, model, first task) and a
 * plain terminal beside it. Start is the page's one primary; Shift on Start opens the agent's launch options.
 */
export function NewTabPage(props: {
  agents: readonly NewTabAgent[];
  /** The agent chosen first; the first in the list when it is not one of them. */
  defaultAgent: string | null;
  worktree: { path: string; label: string };
  shell: { id: string; name: string } | null;
  onStart(agent: string, model: string | null, prompt: string | null): void;
  onOptions(agent: string): void;
  onShell(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { agents, worktree } = props;
  const first = agents.find((a) => a.id === props.defaultAgent)?.id ?? agents[0]?.id ?? "";
  const [value, setValue] = useState<LaunchValue>({ agent: first, worktree: worktree.path, model: "", prompt: "" });
  // A list that changed under the page (a profile turned off) falls back to the first agent.
  const agent = agents.find((a) => a.id === value.agent) ?? agents.find((a) => a.id === first);
  const models = agent?.models ?? [];
  const shown: LaunchValue = { agent: agent?.id ?? "", worktree: worktree.path, model: models.includes(value.model) ? value.model : "", prompt: value.prompt };
  // Read by Start in the same click: the capture phase runs first.
  const shift = useRef(false);

  function start(): void {
    if (!agent) return;
    if (shift.current) return props.onOptions(agent.id);
    const prompt = shown.prompt.trim();
    props.onStart(agent.id, shown.model || null, prompt || null);
  }

  return (
    <div className="ws-center-empty ws-new-tab">
      <p>{t("workspace.tabs.empty")}</p>
      {agent && (
        <div className="ws-new-tab-card" onClickCapture={(e) => (shift.current = e.shiftKey)}>
          <LaunchCard
            agents={agents.map((a) => ({ value: a.id, label: a.name }))}
            worktrees={[{ value: worktree.path, label: worktree.label }]}
            models={[{ value: "", label: t("agentLaunch.model.default") }, ...models.map((m) => ({ value: m, label: m }))]}
            value={shown}
            onChange={(next) => setValue({ ...next, model: next.agent === shown.agent ? next.model : "" })}
            onStart={start}
            labels={{
              region: t("workspace.newTab.region"),
              agent: t("workspace.newTab.agent"),
              worktree: t("workspace.newTab.worktree"),
              model: t("agentLaunch.model"),
              prompt: t("workspace.newTab.prompt"),
              promptPlaceholder: t("workspace.newTab.promptPlaceholder"),
              start: t("workspace.newTab.start"),
            }}
          />
          <p className="ws-new-tab-hint">{t("workspace.newTab.optionsHint")}</p>
        </div>
      )}
      {props.shell && (
        <Button type="button" variant="secondary" onClick={props.onShell}>
          {props.shell.name}
        </Button>
      )}
    </div>
  );
}
