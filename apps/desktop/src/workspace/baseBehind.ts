import type { Api, BaseDrift, GitSettings } from "@/api";
import type { ToastInput } from "./toastStore";

type T = (key: string, vars?: Record<string, string | number>) => string;
type GitApi = Pick<Api, "gitSettings" | "setGitSettings">;

/** Reads the stored Git settings and writes them back with `patch`, so no other field is lost. */
export async function patchGitSettings(api: GitApi, patch: Partial<GitSettings>): Promise<GitSettings> {
  const git = await api.gitSettings();
  return api.setGitSettings({ ...git, ...patch });
}

/**
 * The toast for a new worktree whose local base is behind its upstream. The desktop sends the drift only
 * when the tip is wanted; the actions turn on the refresh before create, or turn the tip off.
 */
export function baseBehindToast(drift: BaseDrift, api: GitApi, t: T): ToastInput {
  const save = (patch: Partial<GitSettings>) => () => void patchGitSettings(api, patch).catch(() => {});
  return {
    id: `base-behind:${drift.local}`,
    text: t("workspace.baseBehind", { base: drift.local, count: drift.behind, upstream: drift.upstream }),
    actions: [
      { label: t("workspace.baseBehind.turnOn"), run: save({ refreshLocalBaseOnCreate: true }) },
      { label: t("workspace.baseBehind.dismiss"), run: save({ localBaseRefreshTipDismissed: true }) },
    ],
    ttlMs: 0,
  };
}
