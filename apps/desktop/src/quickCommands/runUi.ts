import type { Api, FileCommand, QuickCommand } from "@/api";
import { pushToast } from "@/workspace/toastStore";
import { runQuickCommand, type RunContext, type RunResult } from "./run";

type T = (key: string, vars?: Record<string, string | number>) => string;

/**
 * Runs a command for a person: records the use, and says so in a toast when it could not run. The
 * popover and the palette share it.
 */
export async function runWithToast(api: Pick<Api, "quickCommandUsed">, cmd: QuickCommand | FileCommand, ctx: Omit<RunContext, "used">, t: T): Promise<RunResult> {
  const res = await runQuickCommand(cmd, { ...ctx, used: (id) => void api.quickCommandUsed(id).catch(() => {}) });
  if (!res.ok) pushToast({ text: t(`qcmd.failed.${res.reason}`) });
  return res;
}
