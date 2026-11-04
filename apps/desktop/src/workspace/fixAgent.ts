import type { Api, Check, GitSettings } from "@/api";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import { fixPrompt, type FixRecipeId } from "@/settings/recipes";
import { sendToAgentTab, sendToChosenTab } from "./agentPrompt";
import type { Sessions, Tab } from "./sessions";

/**
 * Gives a fix action's prompt to an agent of the worktree: the recipe's template over what the
 * action found (`vars`). A recipe that names an agent opens a tab of that profile; otherwise, or
 * when that profile is gone or off, the agent tab of the worktree takes it as it always did.
 * Resolves the tab used, or `null` when no tab got ready.
 */
export async function sendFix(
  api: Api,
  sessions: Sessions,
  worktree: string,
  shown: string | null,
  id: FixRecipeId,
  vars: Record<string, string>,
): Promise<Tab | null> {
  const git: GitSettings = await api.gitSettings().catch(() => DEFAULT_GIT_SETTINGS);
  const recipe = git.recipes[id];
  const text = fixPrompt(id, recipe, vars);
  if (recipe.agent !== null) {
    const listed = await api.profiles().then(
      (view) => view.profiles.some((p) => p.profile.id === recipe.agent && p.profile.enabled),
      () => false,
    );
    if (listed) return sendToChosenTab(sessions, worktree, { profile: recipe.agent }, text);
  }
  return sendToAgentTab(sessions, worktree, shown, text);
}

/**
 * `sendFix` for a failed check: the failed job's log goes in when `gh` can give it (and the check
 * has a link); without it the prompt still names the check and its link.
 */
export async function sendCheckFix(
  api: Api,
  sessions: Sessions,
  worktree: string,
  shown: string | null,
  branch: string,
  check: Check,
): Promise<Tab | null> {
  const link = check.link ?? "";
  const log = link === "" ? "" : ((await api.worktreeCheckLog(worktree, link).catch(() => null)) ?? "");
  return sendFix(api, sessions, worktree, shown, "fixChecks", {
    branch,
    checkName: check.name,
    workflow: check.workflow ?? "",
    link,
    log,
  });
}
