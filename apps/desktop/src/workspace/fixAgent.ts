import type { Api, Check, GitSettings } from "@/api";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import { fixPrompt, type FixRecipeId } from "@/settings/recipes";
import { sendToAgentTab, sendToChosenTab, type SendChoice } from "./agentPrompt";
import { ackPlan, addressPrompt, commentsJson, type CommentGroup, type PrRef } from "./prComments";
import type { PrCommentStore } from "./prCommentStore";
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

/** What the acknowledgement did on GitHub. */
export interface AckSummary {
  resolved: number;
  replied: number;
  skipped: number;
  failed: number;
}

export const ACK_POOL = 4;

/** Runs `jobs` with at most `size` in flight; each resolves true when it worked. */
async function pool(jobs: (() => Promise<boolean>)[], size: number): Promise<boolean[]> {
  const out: boolean[] = new Array(jobs.length).fill(false);
  let next = 0;
  async function lane(): Promise<void> {
    while (next < jobs.length) {
      const i = next++;
      out[i] = await jobs[i]().catch(() => false);
    }
  }
  await Promise.all(Array.from({ length: Math.min(size, jobs.length) }, lane));
  return out;
}

/** Resolves the open threads and leaves one reply for the rest; counts what worked. */
export async function acknowledge(store: PrCommentStore, worktree: string, number: number, groups: readonly CommentGroup[]): Promise<AckSummary> {
  const plan = ackPlan(groups);
  const jobs: (() => Promise<boolean>)[] = plan.resolve.map((id) => () => store.resolve(worktree, id, true));
  const resolved = plan.resolve.length;
  if (plan.conversation !== null) {
    const body = plan.conversation;
    jobs.push(() => store.post(worktree, number, { body, replyTo: null, path: null, line: null, startLine: null, commit: null }).then(() => true));
  }
  const done = await pool(jobs, ACK_POOL);
  const okResolved = done.slice(0, resolved).filter(Boolean).length;
  const replied = plan.conversation !== null && done[resolved] ? 1 : 0;
  return { resolved: okResolved, replied, skipped: plan.skipped, failed: done.filter((d) => !d).length };
}

/**
 * Gives the selected comment groups to the agent the person chose through the `addressComments`
 * recipe. Only when the prompt was typed in and `ack` is on does anything go to GitHub.
 */
export async function sendCommentsFix(
  api: Api,
  sessions: Sessions,
  store: PrCommentStore,
  pr: PrRef & { branch: string },
  groups: readonly CommentGroup[],
  choice: SendChoice,
  ack: boolean,
): Promise<{ tab: Tab | null; summary: AckSummary | null }> {
  const git: GitSettings = await api.gitSettings().catch(() => DEFAULT_GIT_SETTINGS);
  const text = fixPrompt("addressComments", git.recipes.addressComments, {
    basePrompt: addressPrompt(pr, groups),
    branch: pr.branch,
    prNumber: String(pr.number),
    prUrl: pr.url,
    comments: commentsJson(groups),
  });
  const tab = await sendToChosenTab(sessions, pr.worktree, choice, text);
  if (!tab || !ack) return { tab, summary: null };
  return { tab, summary: await acknowledge(store, pr.worktree, pr.number, groups) };
}

/** The most log a prompt carries for each check when several go at once. */
const LOG_EACH_MAX = 8_000;

/**
 * `sendFix` for every failing check at once: one prompt, the checks named together, each with its
 * log when `gh` can give it. A single check reads as `sendCheckFix` does.
 */
export async function sendChecksFix(
  api: Api,
  sessions: Sessions,
  worktree: string,
  shown: string | null,
  branch: string,
  checks: readonly Check[],
): Promise<Tab | null> {
  if (checks.length === 0) return null;
  if (checks.length === 1) return sendCheckFix(api, sessions, worktree, shown, branch, checks[0]);
  const logs = await Promise.all(
    checks.map(async (c) => (c.link ? ((await api.worktreeCheckLog(worktree, c.link).catch(() => null)) ?? "") : "")),
  );
  const log = checks
    .map((c, i) => (logs[i] === "" ? "" : `--- ${c.name} ---\n${logs[i].slice(-LOG_EACH_MAX)}`))
    .filter(Boolean)
    .join("\n\n");
  const flows = [...new Set(checks.map((c) => c.workflow ?? "").filter(Boolean))];
  return sendFix(api, sessions, worktree, shown, "fixChecks", {
    branch,
    checkName: checks.map((c) => c.name).join(", "),
    workflow: flows.join(", "),
    link: checks.map((c) => c.link ?? "").filter(Boolean).join("\n"),
    log,
  });
}
