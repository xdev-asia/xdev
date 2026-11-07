import { profileName } from "@/agents/profileStore";
import { toApiError, type Api, type ApiError, type Check, type OpenInApp, type OpenTarget, type PrView, type PtyProfile, type RepoGroup, type WorkStatus, type SidebarItem, type SidebarPrefs, type RepoView, type WorktreeView, type ProfilesView } from "@/api";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { pushToast } from "./toastStore";
import { endpoint } from "./PortsChip";
import { sessionFallback } from "./layoutPersist";
import { ActivityPanel, type ActivityTab } from "@/activity/ActivityPanel";
import { ActivityFeed } from "@/activity/feed";
import { RemoteGroup } from "@/remote/RemoteGroup";
import { remoteRows } from "@/remote/model";
import { parentCandidates } from "./lineage";
import { VaultNav } from "./VaultNav";
import type { AgentSessionsStore } from "@/agentSessions/store";
import { SessionsSidebar } from "@/agentSessions/SessionsSidebar";
import { Sessions } from "./sessions";
import { WorktreeStats } from "./stats";
import { WorktreeList } from "./WorktreeList";
import { bulkSleepable, clear as clearPicked, click as pickClick, selectAll, type Selection } from "./selection";
import { BulkBar } from "./BulkBar";
import { worktreeName } from "./shellModel";
import type { JSX } from "react";
import type { useI18n } from "@/i18n";
import type { Dispatch, SetStateAction } from "react";
import type { useRemoteProjects } from "@/remote/useRemoteProjects";
import type { useShellCardPorts } from "@/shell/useShellCardPorts";
import type { useShellCreate } from "@/shell/useShellCreate";
import type { useShellDialogs } from "@/shell/useShellDialogs";
import type { useShellPanels } from "@/shell/useShellPanels";
import type { useShellRemoteActions } from "@/shell/useShellRemoteActions";
import type { useShellRemove } from "@/shell/useShellRemove";
import type { useShellRepoActions } from "@/shell/useShellRepoActions";
import type { useShellViews } from "@/shell/useShellViews";
import type { TabStatus } from "./status";

type T = ReturnType<typeof useI18n>["t"];

/** The left sidebar: the docs vault nav, and the worktrees, sessions and activity views. Holds no state: the shell's hooks own it. */
export function ShellSidebar(p: {
  repo: ReturnType<typeof useShellRepoActions>;
  rm: ReturnType<typeof useShellRemove>;
  remoteActs: ReturnType<typeof useShellRemoteActions>;
  views: ReturnType<typeof useShellViews>;
  panels: ReturnType<typeof useShellPanels>;
  cr: ReturnType<typeof useShellCreate>;
  dialogs: ReturnType<typeof useShellDialogs>;
  api: Api;
  t: T;
  sessions: Sessions | null;
  history: AgentSessionsStore | null;
  repos: RepoView[] | null;
  all: WorktreeView[];
  current: WorktreeView | null;
  items: SidebarItem[] | null;
  prefs: SidebarPrefs;
  picked: Selection;
  setPicked: Dispatch<SetStateAction<Selection>>;
  selectable: string[];
  setOrder: Dispatch<SetStateAction<string[]>>;
  sideView: "worktrees" | "sessions" | "activity";
  setSideView: Dispatch<SetStateAction<"worktrees" | "sessions" | "activity">>;
  sidebarOpen: boolean;
  sessionsAsk: { seq: number; focus: boolean; reveal: { key: string; seq: number } | null };
  activityAsk: { tab: ActivityTab; seq: number };
  feed: ActivityFeed;
  stats: WorktreeStats;
  dots: Record<string, TabStatus | null>;
  activity: Record<string, number | null>;
  profiles: Record<string, PtyProfile[]>;
  unreadMap: Record<string, boolean>;
  asleepMap: Record<string, boolean>;
  sleepableMap: Record<string, boolean>;
  prMap: Record<string, { pr: PrView | null; checks: Check[] | null }>;
  nameView: ProfilesView | null;
  livePorts: ReturnType<typeof useShellCardPorts>["livePorts"];
  stopPort: ReturnType<typeof useShellCardPorts>["stopPort"];
  notice: ApiError["code"] | undefined;
  openInApps: OpenInApp[];
  remote: ReturnType<typeof useRemoteProjects>;
  jumpTo: (id: string) => boolean;
  select: (wt: WorktreeView) => void;
  copy: (text: string) => Promise<void>;
  openIn: (path: string, target: OpenTarget) => Promise<void>;
  newTerminalIn: (wt: WorktreeView, dir?: string) => Promise<void>;
}): JSX.Element {
  const { addFolder, addRepo, adopt, changePrefs, openFolder, pin, setDetails, setEditing, setForgetting, setGroupName, sidebarCall } = p.repo;
  const { archive, bulkEach, openBulk, setReview, startRemove } = p.rm;
  const { disconnectRemote, reconnectRemote, removeRemote } = p.remoteActs;
  const { docsSaved, openSettings, setDocsKey, setDocsMounted, show, view } = p.views;
  const { openPrTab } = p.panels;
  const { pending, startCreate } = p.cr;
  const { setBoardOpen, setCheckingOut, setComposerAsk, setMergeSources, setParentFor, setRenaming } = p.dialogs;
  const { api, t, sessions, history, repos, all, current, items, prefs, picked, setPicked, selectable, setOrder, sideView, setSideView, sidebarOpen, sessionsAsk, activityAsk, feed, stats, dots, activity, profiles, unreadMap, asleepMap, sleepableMap, prMap, nameView, livePorts, stopPort, notice, openInApps, remote, jumpTo, select, copy, openIn, newTerminalIn } = p;
  return (
    <>
        <div id="ws-sidebar" className="ws-sidebar" hidden={!sidebarOpen}>
          <div className="ws-nav" role="group" aria-label={t("workspace.nav.label")} hidden={view !== "docs"}>
            {view === "docs" && (
              <VaultNav
                api={api}
                canOpen={docsSaved}
                onOpened={() => {
                  setDocsMounted(true);
                  setDocsKey((k) => k + 1);
                }}
              />
            )}
          </div>
          <div className="ws-side-tabs" role="group" aria-label={t("agentSessions.tabs.label")}>
            {(["worktrees", "sessions", "activity"] as const).map((v) => (
              <button key={v} type="button" className="ws-side-tab" aria-pressed={sideView === v} onClick={() => setSideView(v)}>
                {t(`agentSessions.tab.${v}`)}
              </button>
            ))}
          </div>
          {sessions && history && (
            <div className="ws-side-view" hidden={sideView !== "sessions"}>
              <SurfaceBoundary id="sidebar.sessions" surface="Sessions sidebar">
                <SessionsSidebar
                  store={history}
                  sessions={sessions}
                  current={current ? { path: current.path, repo: repos?.find((r) => r.worktrees.some((w) => w.path === current.path))?.path ?? null } : null}
                  visible={sideView === "sessions" && sidebarOpen}
                  focusSeq={sessionsAsk.focus ? sessionsAsk.seq : undefined}
                  reveal={sessionsAsk.reveal}
                  onOpened={(tab) => jumpTo(tab.id)}
                  onFocusTab={jumpTo}
                  onGoTo={(path) => {
                    const wt = all.find((w) => w.path === path);
                    if (!wt) return;
                    select(wt);
                    show("workspace");
                  }}
                />
              </SurfaceBoundary>
            </div>
          )}
          {sessions && (
            <div className="ws-side-view" hidden={sideView !== "activity"}>
              <ActivityPanel
                sessions={sessions}
                feed={feed}
                names={Object.fromEntries(all.map((w) => [w.path, { name: worktreeName(all, w.path), branch: w.branch ?? null }]))}
                ask={activityAsk}
                onJump={jumpTo}
              />
            </div>
          )}
          <div className="ws-side-view" hidden={sideView !== "worktrees"}>
          {picked.paths.size >= 2 && (
            <BulkBar
              count={picked.paths.size}
              allPinned={all.filter((w) => picked.paths.has(w.path)).every((w) => w.pinned)}
              onArchive={() => void openBulk("archive")}
              onDelete={() => void openBulk("delete")}
              onPin={() => {
                const pin = !all.filter((w) => picked.paths.has(w.path)).every((w) => w.pinned);
                void bulkEach((path) => api.worktreePin(path, pin));
              }}
              canSleep={bulkSleepable(picked.paths, sleepableMap)}
              onSleep={() => void Promise.all([...picked.paths].map((p) => sessions?.sleepWorktree(p, sessionFallback(api))))}
              onStatus={(status: WorkStatus) => void bulkEach((path) => api.worktreeDetails(path, { status }))}
              onClear={() => setPicked(clearPicked())}
              onMerge={() => {
                if (!sessions) return;
                const chosen = all.filter((w) => picked.paths.has(w.path));
                setMergeSources(
                  chosen.flatMap((w) => sessions.tabs(w.path)).map((tab) => ({ id: tab.id, title: tab.title ?? profileName(nameView, tab.profileId, t), agent: profileName(nameView, tab.profileId, t) })),
                );
              }}
              onSendPrompt={() => setComposerAsk((r) => ({ worktrees: [...picked.paths], seq: (r?.seq ?? 0) + 1 }))}
            />
          )}
          <SurfaceBoundary id="sidebar.worktrees" surface="Workspace list" titleKey="boundary.worktrees.title">
            <WorktreeList
              onOpenPr={() => openPrTab()}
              onOrder={(paths) => setOrder((o) => (o.join(",") === paths.join(",") ? o : paths))}
              picked={picked.paths}
              onPick={(wt, mods) => setPicked((sel) => pickClick(sel, wt.path, selectable, mods))}
              onSelectAll={() => setPicked(selectAll(selectable))}
              onClearPicked={() => setPicked(clearPicked())}
              onReviewBranches={(repoId) => setReview({ repoId, busy: false })}
              items={items}
              prefs={prefs}
              onPrefs={changePrefs}
              onReorder={(ids) => void sidebarCall(() => api.sidebarOrder(ids))}
              onGroupMove={(member, group, index) => void sidebarCall(() => api.groupMove(member, group, index))}
              onNewGroup={() => setGroupName({ id: null, name: "" })}
              onRenameGroup={(g: RepoGroup) => setGroupName({ id: g.id, name: g.name })}
              onRemoveGroup={(g: RepoGroup) => void sidebarCall(() => api.groupRemove(g.id))}
              onAddFolder={() => void addFolder()}
              onOpenFolder={(f) => void openFolder(f)}
              onForgetFolder={(f) => void sidebarCall(() => api.folderForget(f.id))}
              onRestore={(repoId, branch) => void sidebarCall(() => api.worktreeRestore(repoId, branch))}
              onArchive={(wt) => void archive(wt)}
              onOpenBoard={() => setBoardOpen(true)}
              onEditDetails={(wt) => setEditing({ worktree: wt, busy: false })}
              onSetParent={(wt) => setParentFor({ worktree: wt, candidates: parentCandidates(wt, repos?.find((r) => r.worktrees.some((w) => w.path === wt.path))?.worktrees ?? []) })}
              onRemoveParent={(wt) => void setDetails(wt, { parent: null }, t("lineage.error"))}
              onDeleteNested={(wt) => startRemove(wt, { nested: true })}
              onMoveStatus={(wt, status) => {
                if (status !== wt.status) void setDetails(wt, { status }, t("lineage.error"));
              }}
              onRenameBranch={(wt) => setRenaming(wt)}
              onCheckoutBranch={(wt) => setCheckingOut(wt)}
              onCopyLink={(url) => {
                void copy(url);
                pushToast({ text: t("workItem.copied") });
              }}
              selected={current?.path ?? null}
              dots={dots}
              stats={stats.all()}
              ports={livePorts}
              onOpenPort={(port) => void api.portsOpen(port.id).catch((e: unknown) => pushToast({ text: t(`error.${toApiError(e).code}`) }))}
              onCopyPort={(port) => {
                void copy(endpoint(port));
                pushToast({ text: t("ports.copied", { address: endpoint(port) }) });
              }}
              onStopPort={stopPort}
              activity={activity}
              profiles={profiles}
              prs={prMap}
              now={Date.now()}
              notice={notice}
              onSelect={(wt) => {
                setPicked(clearPicked());
                select(wt);
                show("workspace");
              }}
              onCreate={startCreate}
              pending={pending.list()}
              onCancelCreate={(id) => pending.cancel(id)}
              onRetryCreate={(id) => pending.retry(id)}
              onDismissCreate={(id) => pending.dismiss(id)}
              onPin={(wt) => void pin(wt)}
              onRemove={startRemove}
              onAddRepo={addRepo}
              onAdopt={(wt) => void adopt(wt)}
              unread={unreadMap}
              asleep={asleepMap}
              sleepable={sleepableMap}
              onSleep={(wt) => void sessions?.sleepWorktree(wt.path, sessionFallback(api))}
              onSleepNested={(wt) => void sessions?.sleepWorktree(wt.path, sessionFallback(api), all.filter((c) => c.parent === wt.path).map((c) => c.path))}
              onWake={(wt) => [wt.path, ...all.filter((c) => c.parent === wt.path).map((c) => c.path)].forEach((p) => sessions?.wakeWorktree(p))}
              onMarkUnread={(wt) => sessions?.markUnread(wt.path)}
              onMarkRead={(wt) => sessions?.markRead(wt.path)}
              openInApps={openInApps}
              onOpenIn={(path, target) => void openIn(path, target)}
              onCopy={(text) => void copy(text)}
              onNewTerminal={(wt) => void newTerminalIn(wt)}
              onRepoSettings={(repo) => openSettings("repos", repo.id)}
              onRemoveRepo={(repo) => setForgetting({ repo })}
            />
          </SurfaceBoundary>
          <RemoteGroup
            rows={remoteRows(remote.projects)}
            selected={current?.path ?? null}
            onSelect={(row) => {
              const wt = all.find((w) => w.path === row.worktree);
              if (!wt) return;
              setPicked(clearPicked());
              select(wt);
              show("workspace");
            }}
            onReconnect={(row) => void reconnectRemote(row.id)}
            onDisconnect={(row) => void disconnectRemote(row.id)}
            onRemove={(row) => void removeRemote(row.id)}
          />
          </div>
        </div>
    </>
  );
}
