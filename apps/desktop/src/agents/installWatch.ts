import type { Api, ProfilesView } from "@/api";
import { resolveLocale, storedPreference, translate } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";

const say = (key: string, name: string): string =>
  translate(resolveLocale(storedPreference(), typeof navigator === "undefined" ? undefined : navigator.language), key, { name });

/**
 * Waits for the install tab `tabId` to end, reads the agents again (the login PATH is re-read), hands
 * the view to `onView` and says how it went in one toast. Lives outside the page: the page may be
 * gone after the view switch. Returns a function that stops the wait.
 */
export async function watchInstall(
  api: Pick<Api, "onPtyExit" | "agentsRefresh">,
  tabId: string,
  name: string,
  agentId: string,
  onView: (view: ProfilesView) => void,
): Promise<() => void> {
  let stop: (() => void) | null = null;
  let done = false;
  const finish = () => {
    done = true;
    stop?.();
  };
  const toast = (key: string) => pushToast({ id: `agent-install-${tabId}`, text: say(key, name) });
  stop = await api.onPtyExit((exit) => {
    if (done || exit.id !== tabId) return;
    finish();
    void (async () => {
      let view: ProfilesView;
      try {
        view = await api.agentsRefresh();
      } catch {
        toast("settings.agents.install.failed");
        return;
      }
      onView(view);
      if (exit.code !== 0) toast("settings.agents.install.failed");
      else toast(view.profiles.some((p) => p.profile.id === agentId && p.installed) ? "settings.agents.install.done" : "settings.agents.install.notFound");
    })();
  });
  if (done) stop();
  return finish;
}
