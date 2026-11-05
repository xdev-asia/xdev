import type { LaunchVerdict } from "@/api";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The words for what a launch check found out about `agent`, without the raw error. */
export function verdictMessage(t: T, agent: string, verdict: LaunchVerdict): string {
  switch (verdict.kind) {
    case "notInstalled":
      return t("agentLaunch.verdict.notInstalled", { agent });
    case "tooOld":
      return t("agentLaunch.verdict.tooOld", { agent, found: verdict.found, min: verdict.min });
    case "failed":
      return verdict.hint ? t("agentLaunch.verdict.failedHint", { agent, hint: verdict.hint }) : t("agentLaunch.verdict.failed", { agent });
    case "ok":
      return t("agentLaunch.verdict.ok", { agent, version: verdict.version });
  }
}

/** Whether a spawn failure of an agent profile is worth a launch check: the program did not start. */
export function wantsVerdict(code: string): boolean {
  return code === "not_installed" || code === "pty_spawn" || code === "no_claude" || code === "no_codex" || code === "io";
}
