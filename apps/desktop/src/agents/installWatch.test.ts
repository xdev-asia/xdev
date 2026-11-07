import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProfilesView, PtyExit } from "@/api";
import { createMockApi } from "@/mockApi";
import { translate } from "@/i18n";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { watchInstall } from "./installWatch";

const en = (key: string, name = "Gemini CLI") => translate("en", key, { name });

async function setup(installed: string[], refresh?: () => Promise<ProfilesView>) {
  const mock = createMockApi({});
  mock.__installed = installed;
  const view = await mock.profiles();
  let exit: ((e: PtyExit) => void) | null = null;
  const off = vi.fn();
  const api = {
    onPtyExit: async (cb: (e: PtyExit) => void) => {
      exit = cb;
      return off;
    },
    agentsRefresh: refresh ?? (async () => view),
  };
  const onView = vi.fn();
  await watchInstall(api, "tab1", "Gemini CLI", "gemini", onView);
  return { fire: (e: PtyExit) => exit!(e), onView, off, view };
}

const texts = () => getToasts().map((t) => t.text);

describe("watchInstall", () => {
  afterEach(() => resetToastsForTests());

  it("ignores the exit of another tab", async () => {
    const s = await setup(["gemini"]);
    s.fire({ id: "other", code: 0 });
    expect(s.onView).not.toHaveBeenCalled();
    expect(texts()).toEqual([]);
  });

  it("says done when the agent is found, then stops listening", async () => {
    const s = await setup(["gemini"]);
    s.fire({ id: "tab1", code: 0 });
    await vi.waitFor(() => expect(texts()).toEqual([en("settings.agents.install.done")]), { timeout: 2000 });
    expect(s.onView).toHaveBeenCalledWith(s.view);
    expect(s.off).toHaveBeenCalledTimes(1);
    s.fire({ id: "tab1", code: 0 });
    expect(s.onView).toHaveBeenCalledTimes(1);
  });

  it("says not on PATH when exit 0 finds nothing", async () => {
    const s = await setup([]);
    s.fire({ id: "tab1", code: 0 });
    await vi.waitFor(() => expect(texts()).toEqual([en("settings.agents.install.notFound")]), { timeout: 2000 });
  });

  it.each([1, null])("says failed for exit code %s and still hands over the view", async (code) => {
    const s = await setup(["gemini"]);
    s.fire({ id: "tab1", code });
    await vi.waitFor(() => expect(texts()).toEqual([en("settings.agents.install.failed")]), { timeout: 2000 });
    expect(s.onView).toHaveBeenCalledTimes(1);
  });

  it("says failed when the refresh rejects, without throwing", async () => {
    const s = await setup(["gemini"], () => Promise.reject(new Error("x")));
    s.fire({ id: "tab1", code: 0 });
    await vi.waitFor(() => expect(texts()).toEqual([en("settings.agents.install.failed")]), { timeout: 2000 });
    expect(s.onView).not.toHaveBeenCalled();
  });
});
