import { describe, expect, it, vi } from "vitest";
import type { GitSettings } from "@/api";
import { translate } from "@/i18n";
import { DEFAULT_GIT_SETTINGS } from "@/settings/gitDefaults";
import { baseBehindToast } from "./baseBehind";

const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? ` ${JSON.stringify(vars)}` : ""}`;

function fakeApi(start: Partial<GitSettings> = {}) {
  let git: GitSettings = { ...DEFAULT_GIT_SETTINGS, ...start };
  return {
    gitSettings: vi.fn(async () => ({ ...git })),
    setGitSettings: vi.fn(async (next: GitSettings) => {
      git = next;
      return { ...git };
    }),
    get git() {
      return git;
    },
  };
}

const drift = { local: "main", upstream: "origin/main", ahead: 0, behind: 3 };

describe("baseBehindToast", () => {
  it("names the base, the count and the upstream, and stays until closed", () => {
    const toast = baseBehindToast(drift, fakeApi(), t);
    expect(toast.text).toBe('workspace.baseBehind {"base":"main","count":3,"upstream":"origin/main"}');
    expect(toast.ttlMs).toBe(0);
    expect(toast.actions?.map((a) => a.label)).toEqual(["workspace.baseBehind.turnOn", "workspace.baseBehind.dismiss"]);
    const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
    expect(baseBehindToast(drift, fakeApi(), en).text).toBe("Local main is 3 commits behind origin/main");
    expect(baseBehindToast({ ...drift, behind: 1 }, fakeApi(), en).text).toBe("Local main is 1 commit behind origin/main");
  });

  it("turns on the refresh and keeps the other settings", async () => {
    const api = fakeApi({ prDraft: true });
    baseBehindToast(drift, api, t).actions![0].run();
    await vi.waitFor(() => expect(api.setGitSettings).toHaveBeenCalledTimes(1));
    expect(api.git.refreshLocalBaseOnCreate).toBe(true);
    expect(api.git.prDraft).toBe(true);
    expect(api.git.localBaseRefreshTipDismissed).toBe(false);
  });

  it("turns the tip off", async () => {
    const api = fakeApi();
    baseBehindToast(drift, api, t).actions![1].run();
    await vi.waitFor(() => expect(api.setGitSettings).toHaveBeenCalledTimes(1));
    expect(api.git.localBaseRefreshTipDismissed).toBe(true);
    expect(api.git.refreshLocalBaseOnCreate).toBe(false);
  });
});
