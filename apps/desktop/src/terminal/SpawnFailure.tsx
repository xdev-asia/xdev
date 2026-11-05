import { useEffect, useState } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import type { Api, ApiError, LaunchVerdict, PtyProfile } from "@/api";
import { verdictMessage, wantsVerdict } from "@/agentLaunch/verdictCopy";
import { useI18n } from "@/i18n";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * The words for a launch that failed: the verdict of the agent's own check when it found the program
 * missing, too old or silent, else the plain words of the error with its detail.
 */
export function failureCopy(t: T, agent: string, error: ApiError, verdict: LaunchVerdict | null): { text: string; detail: string | null } {
  if (verdict && verdict.kind !== "ok") return { text: verdictMessage(t, agent, verdict), detail: null };
  return { text: t(`error.${error.code}`), detail: error.detail ?? null };
}

/** The text of the warning banner when a terminal could not start (the caller draws the banner); asks the agent for its verdict once. */
export function SpawnFailure(props: { api: Api; error: ApiError; profile: PtyProfile | null }): JSX.Element {
  const { api, error, profile } = props;
  const { t } = useI18n();
  const { view } = useProfiles();
  const [verdict, setVerdict] = useState<LaunchVerdict | null>(null);
  const agent = profile !== null && !profile.startsWith("shell") && !profile.startsWith("xdev:");

  useEffect(() => {
    setVerdict(null);
    if (!agent || profile === null || !wantsVerdict(error.code)) return;
    let live = true;
    api.agentProbe(profile).then(
      (v) => live && setVerdict(v),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [api, error, profile, agent]);

  const copy = failureCopy(t, profile === null ? "" : profileName(view, profile, t), error, verdict);
  return (
    <div className="banner-text">
      <span>{copy.text}</span>
      {copy.detail && <pre className="commands">{copy.detail}</pre>}
    </div>
  );
}
