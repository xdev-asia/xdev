import { toApiError, type Api, type RemoteProjectView } from "@/api";
import type { useI18n } from "@/i18n";
import { reconnectCandidate, remoteError } from "@/remote/model";
import type { Sessions } from "@/workspace/sessions";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** The row actions of remote projects: reconnect, disconnect and remove. Holds no state. */
export function useShellRemoteActions(o: {
  api: Api;
  t: T;
  sessions: Sessions | null;
  remote: { projects: RemoteProjectView[]; reload(): Promise<void> };
}) {
  const { api, t, sessions, remote } = o;
  // The first remote project whose host is not connected: what the palette's Reconnect acts on.
  const pendingReconnect = reconnectCandidate(remote.projects);
  function remoteProject(id: string) {
    return remote.projects.find((p) => p.id === id);
  }
  async function reconnectRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (!p) return;
    try {
      await api.remoteConnect(p.hostId);
    } catch (e) {
      pushToast({ text: remoteError(t, toApiError(e).code, p.hostAlias) });
    }
  }
  async function disconnectRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (p) await api.remoteDisconnect(p.hostId).catch(() => undefined);
  }
  async function removeRemote(id: string): Promise<void> {
    const p = remoteProject(id);
    if (!p) return;
    await api.remoteProjectRemove(id).catch((e: unknown) => pushToast({ text: t(`error.${toApiError(e).code}`) }));
    await remote.reload();
    void sessions?.closeWorktree(p.worktree);
  }

  return { pendingReconnect, reconnectRemote, disconnectRemote, removeRemote };
}
