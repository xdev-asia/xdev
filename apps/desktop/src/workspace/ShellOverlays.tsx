import { profileName } from "@/agents/profileStore";
import { type Api, type ApiError, type PtyProfile, type RepoView, type WorktreeView, type ProfilesView } from "@/api";
import { CrashHost } from "@/crash/CrashHost";
import { MissionHost } from "@/orchestration/MissionHost";
import { ChartsHost } from "@/orchestration/charts/ChartsHost";
import { ResourceHost } from "@/stats/ResourceHost";
import { MergeDialog } from "./MergeDialog";
import { PaletteHost } from "@/palette/PaletteHost";
import { ComposerHost } from "@/composer/ComposerHost";
import { FloatingHost } from "@/floating/FloatingHost";
import { DictationHost } from "@/dictation/DictationHost";
import { repoOf, TaskEditorHost } from "@/tasks/board/TaskEditorHost";
import { openFile as requestOpenFile } from "@/files/openFile";
import { QuickOpenDialog } from "@/search/QuickOpenDialog";
import { recentFiles } from "@/search/recentFiles";
import { Toasts } from "./Toasts";
import { pushToast } from "./toastStore";
import { ForeignTermsHost } from "@/foreignTerms/ForeignTermsHost";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { DetailsDialog } from "./DetailsDialog";
import { CheckoutBranchDialog } from "./CheckoutBranchDialog";
import { RenameBranchDialog } from "./RenameBranchDialog";
import { AddProjectDialog, parentOf } from "./AddProjectDialog";
import { RemoveRepoDialog } from "./RemoveRepoDialog";
import { ParentPickerDialog } from "./ParentPickerDialog";
import { RemoveWorktreeDialog } from "./RemoveWorktreeDialog";
import { TrustDialog } from "./TrustDialog";
import { AccountSwitchDialog } from "./AccountSwitchDialog";
import { QuitDialog } from "./QuitDialog";
import { AboutDialog } from "./AboutDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SshAuthPrompts } from "@/components/SshAuthDialog";
import { PeersHost } from "@/peers/PeersHost";
import { annotateClipboard } from "@/capture/annotateBridge";
import { CaptureHost } from "@/capture/CaptureHost";
import { startCapture } from "@/capture/useCaptureFailures";
import { confirmResume } from "@/agentSessions/resumeFlow";
import type { Sessions } from "./sessions";
import { NameDialog } from "./NameDialog";
import { BulkRemoveDialog } from "./BulkRemoveDialog";
import { ReviewBranchesDialog } from "./ReviewBranchesDialog";
import { KanbanBoard } from "./KanbanBoard";
import { worktreeName } from "./shellModel";
import { runWithToast } from "@/quickCommands/runUi";
import type { Dispatch, JSX, SetStateAction } from "react";
import type { useI18n } from "@/i18n";
import type { useRemoteProjects } from "@/remote/useRemoteProjects";
import type { useShellAccountSwitch } from "@/shell/useShellAccountSwitch";
import type { useShellCreate } from "@/shell/useShellCreate";
import type { useShellDialogs } from "@/shell/useShellDialogs";
import type { useShellLayoutRestore } from "@/shell/useShellLayoutRestore";
import type { useShellPanels } from "@/shell/useShellPanels";
import type { useShellRemoteActions } from "@/shell/useShellRemoteActions";
import type { useShellRemove } from "@/shell/useShellRemove";
import type { useShellRepoActions } from "@/shell/useShellRepoActions";
import type { useShellSetup } from "@/shell/useShellSetup";
import type { useShellViews } from "@/shell/useShellViews";
import type { SetupGate } from "./setupGate";
import type { TabStatus } from "./status";
import type { AgentSessionsStore } from "@/agentSessions/store";

type T = ReturnType<typeof useI18n>["t"];

/** The dialogs, prompts and hosts that float over the shell. Holds no state: the shell's hooks own it. */
export function ShellOverlays(p: {
  repo: ReturnType<typeof useShellRepoActions>;
  rm: ReturnType<typeof useShellRemove>;
  cr: ReturnType<typeof useShellCreate>;
  setup: ReturnType<typeof useShellSetup>;
  remoteActs: ReturnType<typeof useShellRemoteActions>;
  acct: ReturnType<typeof useShellAccountSwitch>;
  views: ReturnType<typeof useShellViews>;
  panels: ReturnType<typeof useShellPanels>;
  layout: ReturnType<typeof useShellLayoutRestore>;
  dialogs: ReturnType<typeof useShellDialogs>;
  api: Api;
  t: T;
  history: AgentSessionsStore | null;
  sessions: Sessions | null;
  repos: RepoView[] | null;
  all: WorktreeView[];
  current: WorktreeView | null;
  dots: Record<string, TabStatus | null>;
  profiles: Record<string, PtyProfile[]>;
  nameView: ProfilesView | null;
  shownTab: Record<string, string | null>;
  remote: ReturnType<typeof useRemoteProjects>;
  removingRepo: RepoView | undefined;
  gate: SetupGate;
  live: { ensureMounted(worktree: string): void };
  dialogOpen: boolean;
  load: () => Promise<unknown>;
  select: (wt: WorktreeView) => void;
  jumpTo: (id: string) => boolean;
  focusTerminal: (worktree: string) => void;
  openFileSide: (worktree: string, rel: string, line?: number, column?: number) => void;
  openSessionsPanel: (sessionId: string | null) => void;
  setNotice: (code: ApiError["code"] | undefined) => void;
  setSidebarOpen: Dispatch<SetStateAction<boolean>>;
  setFront: Dispatch<SetStateAction<{ worktree: string; id: string; seq: number } | null>>;
}): JSX.Element {
  const { addPaths, addRepo, addRepoFolder, addScanned, adding, addingRemote, editing, forgetRepo, forgetting, groupName, projectCreated, repoCloned, saveDetails, saveGroup, scanRoot, setAdding, setAddingRemote, setDetails, setEditing, setForgetting, setGroupName, setScanRoot } = p.repo;
  const { archiveRemoving, bulk, confirmBulk, remove, removeRun, removing, review, reviewDo, reviewKept, setBulk, setRemoving, setReview, skipDeleteConfirm } = p.rm;
  const { create, createTab, creating, setCreating, startCreate, startFromIssue, startFromMr, startFromPr } = p.cr;
  const { confirmTrust, setTrusting, setupAfterCreate, trusting } = p.setup;
  const { pendingReconnect, reconnectRemote } = p.remoteActs;
  const { answerSwitch, setSwitching, switching } = p.acct;
  const { openDecompose, openSearch, openSettings, openTask, openTaskBoard, show, view } = p.views;
  const { changesReady, runOnChanges } = p.panels;
  const { quitting } = p.layout;
  const { about, boardOpen, checkingOut, composerAsk, confirmEndAll, jumpOpen, machine, mergeSources, parentFor, quickOpen, renaming, setAbout, setBoardOpen, setCheckingOut, setConfirmEndAll, setJumpOpen, setMergeSources, setParentFor, setQuickOpen, setRenaming } = p.dialogs;
  const { api, t, history, sessions, repos, all, current, dots, profiles, nameView, shownTab, remote, removingRepo, gate, live, dialogOpen, load, select, jumpTo, focusTerminal, openFileSide, openSessionsPanel, setNotice, setSidebarOpen, setFront } = p;
  return (
    <>
      <SshAuthPrompts api={api} />
      <PeersHost api={api} />

      {creating && repos && (
        <CreateWorktreeDialog
          repos={repos}
          repoId={creating.repoId}
          name={creating.name}
          status={creating.status}
          agents={creating.agents}
          defaultAgent={creating.defaultAgent}
          namePreview={api.worktreeNamePreview}
          branches={api.worktreeBranches}
          api={api}
          initialTab={createTab.current}
          onTabChange={(tab) => (createTab.current = tab)}
          onStartPr={(repoId, pr) => {
            setCreating(null);
            void startFromPr(repoId, pr);
          }}
          onStartMr={(repoId, mr) => {
            setCreating(null);
            void startFromMr(repoId, mr);
          }}
          onCreate={(repoId, name, from, extra, request, more) => create(repoId, name, from, extra, request, more)}
          resolveIssue={(repoId, text) => api.issueResolve(repoId, text)}
          onStartIssue={(repoId, issue) => {
            setCreating(null);
            void startFromIssue(repoId, issue);
          }}
          onCancel={() => setCreating(null)}
        />
      )}
      <QuickOpenDialog
        open={quickOpen}
        api={api}
        worktree={current?.path ?? null}
        recent={recentFiles}
        onClose={() => setQuickOpen(false)}
        onOpen={(rel, { line, column, side }) => {
          if (!current) return;
          if (side) openFileSide(current.path, rel, line, column);
          else requestOpenFile({ worktree: current.path, rel, line, column });
        }}
      />
      <FloatingHost api={api} />
      <DictationHost api={api} openSettings={(section) => openSettings(section)} />
      <ComposerHost
        api={api}
        sessions={sessions}
        shownTab={current ? (shownTab[current.path] ?? null) : null}
        names={Object.fromEntries(all.map((w) => [w.path, worktreeName(all, w.path)]))}
        active={view === "workspace" && !dialogOpen}
        request={composerAsk}
      />
      <TaskEditorHost api={api} repos={repos} current={current} />
      <CaptureHost api={api} sessions={() => sessions} current={() => current?.path ?? null} shownTab={() => (current ? (shownTab[current.path] ?? null) : null)} />
      <PaletteHost
        open={jumpOpen}
        onClose={() => setJumpOpen(false)}
        repos={repos}
        sessions={sessions}
        history={history}
        tasks={() => api.tasks()}
        targets={(wt) => api.targetsList(wt)}
        current={current}
        shownTab={current ? shownTab[current.path] ?? null : null}
        actions={{
          openTask,
          openTaskBoard,
          openDecompose,
          selectWorktree: (wt) => {
            select(wt);
            show("workspace");
            focusTerminal(wt.path);
          },
          showWorkspace: () => show("workspace"),
          openFile: (worktree, rel) => {
            show("workspace");
            requestOpenFile({ worktree, rel });
          },
          frontTab: (worktree, id) => {
            setFront((f) => ({ worktree, id, seq: (f?.seq ?? 0) + 1 }));
            focusTerminal(worktree);
          },
          openSettings: (section, target) => openSettings(section, undefined, target),
          newWorktree: (name) => startCreate(undefined, name),
          addRepo,
          remoteAdd: () => {
            setNotice(undefined);
            setScanRoot(undefined);
            setAddingRemote(true);
            setAdding(true);
          },
          remoteReconnect: pendingReconnect ? () => void reconnectRemote(pendingReconnect.id) : undefined,
          searchDocs: openSearch,
          toggleSidebar: () => setSidebarOpen((o) => !o),
          showDocs: () => show("docs"),
          stageAllChanges: changesReady ? () => runOnChanges((h) => h.stageAll()) : undefined,
          openSessions: () => openSessionsPanel(null),
          resumeSession: (row) => {
            if (!sessions || !row.worktree) return;
            jumpTo(confirmResume(sessions, { row, worktree: row.worktree }).id);
          },
          discardAllChanges: changesReady ? () => runOnChanges((h) => h.discardAll()) : undefined,
          runQuickCommand: (cmd) => {
            if (!sessions || !current) return;
            const path = current.path;
            const front = sessions.tabs(path).find((x) => x.id === shownTab[path]);
            show("workspace");
            void api
              .profiles()
              .then((v) => v.profiles.map((p) => p.profile.id))
              .catch(() => undefined)
              .then((profiles) =>
                runWithToast(api, cmd, { sessions, worktree: path, tab: front && front.exitCode === undefined ? front : null, profiles, focus: () => focusTerminal(path) }, t),
              );
          },
          newQuickCommand: () => openSettings("qcmd", "new"),
          captureScreen: () => startCapture(api, t),
          annotateClipboard: () => void annotateClipboard(api, t),
        }}
      />
      {trusting && (
        <TrustDialog
          repo={repos?.find((r) => r.id === trusting.repoId)?.shortName ?? ""}
          file="xdev.toml"
          kind={trusting.kind}
          text={trusting.text}
          shared={trusting.lists.shared}
          tabs={trusting.lists.tabs}
          changed={trusting.changed}
          busy={trusting.busy}
          error={trusting.error}
          onTrust={() => void confirmTrust()}
          onCancel={() => {
            const ask = trusting;
            setTrusting(null);
            // Without the lists the flow goes on: setup cards, setup itself.
            if (ask.kind === "lists") void setupAfterCreate(ask.path, ask.repoId, true);
          }}
        />
      )}
      {switching && (
        <AccountSwitchDialog provider={switching.provider} to={switching.to} tab={switching.tab} onApply={answerSwitch} onCancel={() => setSwitching(null)} />
      )}
      {quitting && <QuitDialog ask={quitting.ask} onChoose={quitting.answer} />}
      {about !== null && <AboutDialog version={about} machine={machine} buildDate={import.meta.env.VITE_BUILD_DATE} onLink={(link) => void api.helpOpen(link)} onClose={() => setAbout(null)} />}
      <ConfirmDialog
        open={confirmEndAll}
        title={t("shell.quitEndAll.title")}
        body={t("shell.quitEndAll.body")}
        confirmLabel={t("shell.quitEndAll.confirm")}
        onConfirm={() => {
          setConfirmEndAll(false);
          void api.shellQuit("end-all");
        }}
        onCancel={() => setConfirmEndAll(false)}
      />
      <CrashHost api={api} />
      {mergeSources && <MergeDialog api={api} sources={mergeSources} onClose={() => setMergeSources(null)} />}
      <ResourceHost
        api={api}
        tabs={() => (sessions?.worktrees() ?? []).flatMap((w) => sessions!.tabs(w)).map((tab) => ({ id: tab.id, title: tab.title ?? profileName(nameView, tab.profileId, t), agent: profileName(nameView, tab.profileId, t) }))}
        onStop={(id) => sessions?.close(id) ?? Promise.resolve()}
      />
      <MissionHost api={api} focusTab={jumpTo} frontTab={() => (current ? shownTab[current.path] ?? null : null)} />
      <ChartsHost
        api={api}
        host={
          sessions
            ? {
                worktree: () => current?.path ?? null,
                open: (worktree, seat, opts) => {
                  live.ensureMounted(worktree);
                  sessions.open(worktree, seat.agent, null, undefined, opts);
                },
                defer: (worktree, launch) => gate.defer(worktree, launch),
                newId: () => crypto.randomUUID(),
              }
            : null
        }
      />
      <ForeignTermsHost
        api={api}
        onOpenFolder={(path) => void addPaths([path], true)}
        onResume={(row) => {
          if (!sessions || !row.worktree) return;
          jumpTo(confirmResume(sessions, { row, worktree: row.worktree }).id);
        }}
      />
      <Toasts />
      {adding && (
        <AddProjectDialog
          api={api}
          startFolder={parentOf(repos?.[repos.length - 1]?.path ?? "")}
          onOpenFolder={() => void addRepoFolder()}
          onCloned={(repo) => void repoCloned(repo)}
          onCreated={(created) => void projectCreated(created)}
          startRemote={addingRemote}
          onCancel={() => {
            setAdding(false);
            setAddingRemote(false);
            setScanRoot(undefined);
          }}
          scanRoot={scanRoot}
          onAddRepos={(paths) => void addScanned(paths)}
          onRemoteAdded={(p) => {
            setAdding(false);
            void remote.reload().then(() => {
              select({ path: p.worktree } as WorktreeView);
              show("workspace");
            });
          }}
          onOpenSettings={() => {
            setAdding(false);
            openSettings("ssh");
          }}
        />
      )}
      {forgetting && (
        <RemoveRepoDialog
          name={forgetting.repo.shortName}
          worktrees={forgetting.repo.worktrees.length}
          tabs={forgetting.repo.worktrees.flatMap((w) => sessions?.tabs(w.path) ?? []).map((tab) => tab.title ?? tab.profileId)}
          error={forgetting.error}
          onConfirm={() => void forgetRepo(forgetting.repo)}
          onCancel={() => setForgetting(null)}
        />
      )}
      {groupName && (
        <NameDialog
          heading={t(groupName.id ? "group.rename" : "group.new")}
          label={t("group.name")}
          initial={groupName.name}
          error={groupName.error}
          onSave={(name) => void saveGroup(name)}
          onCancel={() => setGroupName(null)}
        />
      )}
      {editing && (
        <DetailsDialog
          api={api}
          repoId={repos?.find((r) => r.worktrees.some((w) => w.path === editing.worktree.path))?.id ?? ""}
          worktree={editing.worktree}
          siblings={repos?.find((r) => r.worktrees.some((w) => w.path === editing.worktree.path))?.worktrees ?? []}
          busy={editing.busy}
          error={editing.error}
          onSave={(patch) => void saveDetails(patch)}
          onCancel={() => setEditing(null)}
        />
      )}
      {boardOpen && (
        <KanbanBoard
          worktrees={repos?.find((r) => r.worktrees.some((w) => w.path === current?.path))?.worktrees ?? all}
          selected={current?.path ?? null}
          dots={dots}
          profiles={profiles}
          onSelect={(wt) => {
            setBoardOpen(false);
            select(wt);
            show("workspace");
          }}
          onMove={async (wt, status) => {
            await api.worktreeDetails(wt.path, { status });
            await load();
          }}
          onMoveError={() => pushToast({ text: t("kanban.moveError") })}
          api={api}
          repoPath={repoOf(repos, current)}
          onTaskError={() => pushToast({ id: "board-sync-failed", text: t("kanban.taskSyncError") })}
          onClose={() => setBoardOpen(false)}
          onNew={(status) => startCreate(undefined, undefined, status)}
        />
      )}
      {parentFor && (
        <ParentPickerDialog
          worktree={parentFor.worktree}
          candidates={parentFor.candidates}
          onPick={(path) => {
            const wt = parentFor.worktree;
            setParentFor(null);
            void setDetails(wt, { parent: path }, t("lineage.error"));
          }}
          onCancel={() => setParentFor(null)}
        />
      )}
      {renaming && (
        <RenameBranchDialog
          api={api}
          worktree={renaming}
          onRenamed={() => {
            setRenaming(null);
            void load();
          }}
          onClose={() => setRenaming(null)}
        />
      )}
      {checkingOut && (
        <CheckoutBranchDialog
          api={api}
          worktree={checkingOut}
          onDone={() => {
            setCheckingOut(null);
            void load();
          }}
          onClose={() => setCheckingOut(null)}
        />
      )}
      {bulk && (
        <BulkRemoveDialog
          mode={bulk.mode}
          worktrees={bulk.worktrees}
          dirty={bulk.dirty}
          children={Object.fromEntries(bulk.worktrees.map((w) => [w.path, all.filter((c) => c.parent === w.path && !bulk.worktrees.some((b) => b.path === c.path)).map((c) => c.path)]))}
          busy={bulk.busy}
          result={bulk.result}
          onConfirm={(opts) => void confirmBulk(opts)}
          onCancel={() => setBulk(null)}
        />
      )}
      {review && (
        <ReviewBranchesDialog
          kept={reviewKept}
          busy={review.busy}
          error={review.error}
          onDelete={(entry) => void reviewDo(() => api.branchDelete(entry.repoId, entry.branch, true))}
          onKeep={(entry) => void reviewDo(() => api.keptKeep(entry.repoId, entry.branch))}
          onClose={() => setReview(null)}
        />
      )}
      {removing && !removing.quiet && (
        <RemoveWorktreeDialog
          worktree={removing.worktree}
          base={removingRepo?.baseRef ?? ""}
          dirty={removing.dirty}
          busy={removing.busy}
          archiving={removing.archiving}
          failed={removing.failed}
          error={removing.error}
          onConfirm={(nested) => void remove(removing.failed !== undefined, nested)}
          onDontAsk={(skip) => skip && skipDeleteConfirm()}
          onArchive={() => void archiveRemoving()}
          children={all.filter((c) => c.parent === removing.worktree.path).length}
          nestedDefault={removing.nested}
          onCancel={() => {
            removeRun.current++;
            setRemoving(null);
          }}
        />
      )}
    </>
  );
}
