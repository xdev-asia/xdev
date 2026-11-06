import type { Api, ApiError, SimDevice } from "@/api";
import { toApiError } from "@/api";
import { terminalBytes } from "@/quickCommands/run";
import type { Sessions, Tab } from "@/workspace/sessions";
import { logTabTitle } from "./simsModel";

type T = (key: string, vars?: Record<string, string | number>) => string;

export type SimResult = { ok: true; tabs: Tab[] } | { ok: false; code: ApiError["code"] };

/**
 * Boots a simulator and shows it: an emulator tab when the device needs a foreground process (Android),
 * then a log tab. Each command is typed into a new shell tab, the same way a deploy is (`runTarget.ts`).
 */
export async function runSim(
  device: SimDevice,
  ctx: { api: Pick<Api, "simBoot">; sessions: Sessions; worktree: string; t: T },
): Promise<SimResult> {
  let launch;
  try {
    launch = await ctx.api.simBoot({ platform: device.platform, id: device.id });
  } catch (e) {
    return { ok: false, code: toApiError(e).code };
  }
  const tabs: Tab[] = [];
  const open = (title: string, command: string) => {
    const tab = ctx.sessions.open(ctx.worktree, "shell", null, undefined, { title });
    tab.client.typeWhenReady(terminalBytes(command, true));
    tabs.push(tab);
  };
  if (launch.tabCommand) open(device.name, launch.tabCommand);
  open(logTabTitle(device, ctx.t), launch.logCommand);
  return { ok: true, tabs };
}
