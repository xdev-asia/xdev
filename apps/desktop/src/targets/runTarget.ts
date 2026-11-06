import type { Api, DeployPreset, VpsTarget } from "@/api";
import { openFile } from "@/files/openFile";
import { terminalBytes } from "@/quickCommands/run";
import type { Sessions, Tab } from "@/workspace/sessions";
import { SSH_SHELL_PREFIX } from "@/agents/profileStore";
import { cdLine } from "./targetsModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

export type DeployResult = { ok: true; tab: Tab } | { ok: false; reason: "cancelled" };

/**
 * Runs a deploy preset as a visible command in a new shell tab. A preset with `confirm` asks first;
 * `confirm` resolves false for Cancel and nothing is opened or typed.
 */
export async function runDeploy(
  preset: DeployPreset,
  ctx: { sessions: Sessions; worktree: string; t: T; confirm?: (preset: DeployPreset) => Promise<boolean> },
): Promise<DeployResult> {
  if (preset.confirm && ctx.confirm && !(await ctx.confirm(preset))) return { ok: false, reason: "cancelled" };
  const tab = ctx.sessions.open(ctx.worktree, "shell", null, undefined, {
    title: ctx.t("targets.deploy.tab", { name: preset.name }),
  });
  tab.client.typeWhenReady(terminalBytes(preset.run, true));
  return { ok: true, tab };
}

/**
 * Opens an SSH tab to the `[vps]` host, goes to its folder, and opens its notes file beside it when
 * the file exists in the worktree.
 */
export async function openServerShell(
  vps: VpsTarget,
  ctx: { api: Pick<Api, "targetsVpsNotes">; sessions: Sessions; worktree: string },
): Promise<Tab> {
  const tab = ctx.sessions.open(ctx.worktree, `${SSH_SHELL_PREFIX}${vps.host}`);
  const cd = cdLine(vps);
  if (cd) tab.client.typeWhenReady(terminalBytes(cd, true));
  const notes = await ctx.api.targetsVpsNotes(ctx.worktree).catch(() => null);
  if (notes) openFile({ worktree: ctx.worktree, rel: notes, side: true });
  return tab;
}
