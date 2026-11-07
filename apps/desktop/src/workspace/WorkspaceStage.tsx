import { type Api, type RepoView, type WorktreeChange, type WorktreeView } from "@/api";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { StartupBanner } from "@/startup/StartupBanner";
import { fileTabRel } from "@/files/fileTabs";
import { onOpenFile, openFile as requestOpenFile } from "@/files/openFile";
import { SearchPanel } from "@/search/SearchPanel";
import { ReviewPanel } from "./ReviewPanel";
import { Button } from "@xdev-asia/ui";
import { ChecksPanel } from "./ChecksPanel";
import { PortsPanel } from "@/ports/PortsPanel";
import type { PortsStore } from "@/ports/portsStore";
import { IssuesPanel } from "@/issues/IssuesPanel";
import { FileTree } from "./FileTree";
import { RemoteBanner } from "@/remote/RemoteBanner";
import { projectOf } from "@/remote/model";
import { SetupCard } from "./SetupCard";
import type { Sessions } from "./sessions";
import type { PrCommentStore } from "./prCommentStore";
import type { PrStore } from "./prs";
import { WorktreeChanges } from "./WorktreeChanges";
import type { CommitAsk } from "./CommitView";
import { WorktreeTabs, type Reveal } from "./WorktreeTabs";
import { RightPanel } from "@/panel/RightPanel";
import { worktreeName } from "./shellModel";
import type { JSX } from "react";
import type { useI18n } from "@/i18n";
import type { Dispatch, SetStateAction } from "react";
import type { useRemoteProjects } from "@/remote/useRemoteProjects";
import type { useShellAgentFix } from "@/shell/useShellAgentFix";
import type { useShellCreate } from "@/shell/useShellCreate";
import type { useShellPanels } from "@/shell/useShellPanels";
import type { useShellRemoteActions } from "@/shell/useShellRemoteActions";
import type { useShellRepoActions } from "@/shell/useShellRepoActions";
import type { useShellSetup } from "@/shell/useShellSetup";
import type { useShellViews } from "@/shell/useShellViews";
import type { SetupGate } from "./setupGate";
import type { useWorktreeWatch } from "./useWorktreeWatch";

type T = ReturnType<typeof useI18n>["t"];

/** The workspace stage: the startup banner, the worktree tabs and the right panel. Holds no state: the shell's hooks own it. */
export function WorkspaceStage(p: {
  repo: ReturnType<typeof useShellRepoActions>;
  setup: ReturnType<typeof useShellSetup>;
  fix: ReturnType<typeof useShellAgentFix>;
  panels: ReturnType<typeof useShellPanels>;
  views: ReturnType<typeof useShellViews>;
  remoteActs: ReturnType<typeof useShellRemoteActions>;
  cr: ReturnType<typeof useShellCreate>;
  api: Api;
  t: T;
  sessions: Sessions | null;
  repos: RepoView[] | null;
  all: WorktreeView[];
  current: WorktreeView | null;
  currentRepo: RepoView | null;
  mounted: string[];
  count: number;
  failing: number;
  markedChanges: WorktreeChange[];
  front: { worktree: string; id: string; seq: number } | null;
  setFront: Dispatch<SetStateAction<{ worktree: string; id: string; seq: number } | null>>;
  shownTab: Record<string, string | null>;
  setShownTab: Dispatch<SetStateAction<Record<string, string | null>>>;
  setPanes: Dispatch<SetStateAction<Record<string, string[]>>>;
  reveal: (Reveal & { worktree: string }) | null;
  commitAsk: (CommitAsk & { worktree: string }) | null;
  termFocus: { worktree: string; seq: number } | null;
  quickSeq: number;
  prs: PrStore;
  prComments: PrCommentStore;
  ports: PortsStore;
  fsWatch: ReturnType<typeof useWorktreeWatch>;
  gate: SetupGate;
  live: { openPrPage(): void };
  remote: ReturnType<typeof useRemoteProjects>;
  jumpTo: (id: string) => boolean;
  showInHistory: (sessionId: string) => void;
  openFile: (worktree: string, file: string) => void;
  openCommit: (worktree: string, id: string, file: string | null) => void;
  newTerminalIn: (wt: WorktreeView, dir?: string) => Promise<void>;
}): JSX.Element {
  const { addRepo } = p.repo;
  const { cardFor, cards, dropCard, openTabsFor, runSetup } = p.setup;
  const { fixCheck, fixChecks, fixNote, fixWithAgent, resolveConflicts, sendComments } = p.fix;
  const { focusSearch, issuesGit, issuesPinned, panelTab, panelWidth, prPage, registerChanges, resizePanel, rightOpen, searchFocus, setChangeCount, setChangeList, setPanelTab } = p.panels;
  const { openSettings, view } = p.views;
  const { reconnectRemote } = p.remoteActs;
  const { startFromIssue } = p.cr;
  const { api, t, sessions, repos, all, current, currentRepo, mounted, count, failing, markedChanges, front, setFront, shownTab, setShownTab, setPanes, reveal, commitAsk, termFocus, quickSeq, prs, prComments, ports, fsWatch, gate, live, remote, jumpTo, showInHistory, openFile, openCommit, newTerminalIn } = p;
  return (
    <>
        <div className="ws-stage" hidden={view !== "workspace"}>
          <div className="startup-banner-host">
            <StartupBanner api={api} />
          </div>
          <div className="ws-stage-body">
            <main className="ws-center" aria-label={t("workspace.center.label")}>
              {view === "workspace" && <RemoteBanner project={projectOf(remote.projects, current?.path ?? null)} onReconnect={(p) => void reconnectRemote(p.id)} />}
              {sessions &&
                mounted.map((path) => (
                  <SurfaceBoundary key={path} id="workspace.tabs" surface="Workspace tabs" resetKey={path} titleKey="boundary.workspace.title">
                    <WorktreeTabs
                      api={api}
                      sessions={sessions}
                      worktree={path}
                      branch={repos?.flatMap((r) => r.worktrees).find((w) => w.path === path)?.branch ?? null}
                      visible={path === current?.path}
                      onShown={(id) => setShownTab((s) => (s[path] === id ? s : { ...s, [path]: id }))}
                      onPanes={(ids) => setPanes((s) => (s[path]?.join(" ") === ids.join(" ") ? s : { ...s, [path]: ids }))}
                      reveal={reveal?.worktree === path ? { file: reveal.file, seq: reveal.seq, base: reveal.base } : undefined}
                      commit={commitAsk?.worktree === path ? { id: commitAsk.id, file: commitAsk.file, seq: commitAsk.seq } : undefined}
                      prPage={prPage?.worktree === path ? prPage.seq : undefined}
                      renderPrPage={(shown) => <ReviewPanel page api={api} worktree={path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={shown} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} onOpenFile={(rel) => openFile(path, rel)} />}
                      front={front?.worktree === path ? { id: front.id, seq: front.seq } : undefined}
                      focusSeq={termFocus?.worktree === path ? termFocus.seq : undefined}
                      onShowHistory={showInHistory}
                      gate={gate}
                      repo={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.path ?? null}
                      repoName={repos?.find((r) => r.worktrees.some((w) => w.path === path))?.shortName ?? ""}
                      repoId={path.startsWith("ssh://") ? undefined : repos?.find((r) => r.worktrees.some((w) => w.path === path))?.id}
                      quickSeq={path === current?.path ? quickSeq : undefined}
                      onManageQuickCommands={() => openSettings("qcmd")}
                      onLinkSettings={() => openSettings("terminal", undefined, "terminal.linkClick")}
                      onManageAgents={() => openSettings("agents")}
                      worktrees={all.map((w) => ({ path: w.path, label: worktreeName(all, w.path) }))}
                      onJump={jumpTo}
                    />
                  </SurfaceBoundary>
                ))}
              {current && cardFor(current.path) && (
                <SetupCard
                  state={cardFor(current.path)!}
                  onSave={() => {
                    const card = cards[current.path];
                    if (card?.kind !== "detected") return;
                    void api.repoUpdate(card.repoId, { localSetup: card.command }).then(() => dropCard(current.path), () => {});
                  }}
                  onConfigure={() => {
                    dropCard(current.path);
                    openSettings("repos");
                  }}
                  onDismiss={() => {
                    dropCard(current.path);
                    void openTabsFor(current.path);
                  }}
                  onRun={() => void runSetup(current.path, cards[current.path]?.repoId ?? "")}
                  onSkip={() => {
                    dropCard(current.path);
                    void openTabsFor(current.path);
                  }}
                  onAlways={() => {
                    const repoId = cards[current.path]?.repoId;
                    if (!repoId) return;
                    void api.repoUpdate(repoId, { setupPolicy: "run" }).then(() => runSetup(current.path, repoId), () => {});
                  }}
                  onStartNow={() => gate.startNow(current.path)}
                  onOpenTabs={() => gate.openTabs(current.path)}
                  onOpenSetup={() => {
                    const id = gate.setupTab(current.path);
                    if (id) setFront((f) => ({ worktree: current.path, id, seq: (f?.seq ?? 0) + 1 }));
                  }}
                />
              )}
              {!current && repos && (
                <div className="ws-center-empty">
                  <p>{t("workspace.center.none")}</p>
                  <Button type="button" variant="primary" data-field="add-project" onClick={addRepo}>
                    {t("workspace.center.add")}
                  </Button>
                </div>
              )}
              {fixNote && (
                <p className="error-text ws-notice" role="alert">
                  {t("ship.fix.noTab")}
                </p>
              )}
            </main>
            <RightPanel open={rightOpen} width={panelWidth} onResize={resizePanel} tab={panelTab} changes={count} failing={failing} issuesTab={issuesGit.tab} issuesPinned={issuesPinned} onTab={(tab, focus) => { setPanelTab(tab); if (focus) focusSearch(); }}>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "files"}>
                <SurfaceBoundary id="panel.files" surface="Right sidebar: files" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <FileTree
                      key={current.path}
                      api={api}
                      worktree={current.path}
                      changes={markedChanges}
                      queue={fsWatch.queue}
                      watchHealth={fsWatch.health}
                      onOpen={(file) => openFile(current.path, file)}
                      activeFile={fileTabRel(shownTab[current.path] ?? "")}
                      onOpenTerminal={(dir) => void newTerminalIn(current, dir)}
                      onSearch={focusSearch}
                    />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "search"}>
                <SurfaceBoundary id="panel.search" surface="Right sidebar: search" resetKey={current?.path} titleKey="boundary.panel.title">
                  <SearchPanel
                    key={current?.path ?? ""}
                    api={api}
                    worktree={current?.path ?? null}
                    focusSeq={searchFocus}
                    onOpen={(rel, at) => current && requestOpenFile({ worktree: current.path, rel, line: at.line, column: at.column })}
                  />
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "changes"}>
                <SurfaceBoundary id="panel.changes" surface="Right sidebar: changes" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <WorktreeChanges
                      key={current.path}
                      api={api}
                      worktree={current}
                      sessions={sessions}
                      prs={prs}
                      onOpenFile={(file) => openFile(current.path, file)}
                      onOpenCommit={(id, file) => openCommit(current.path, id, file)}
                      onCount={(n) => setChangeCount({ worktree: current.path, count: n })}
                      onChanges={(list) => setChangeList({ worktree: current.path, list })}
                      onFixWithAgent={(output) => void fixWithAgent("fixCommitFailure", output)}
                      onFixPush={(output, branch) => void fixWithAgent("fixPushFailure", output, branch)}
                      onResolveConflicts={(vars) => void resolveConflicts(vars)}
                      onOpenGitSettings={() => openSettings("git")}
                      register={registerChanges}
                    />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "checks"}>
                <SurfaceBoundary id="panel.checks" surface="Right sidebar: checks" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <ChecksPanel key={current.path} api={api} worktree={current.path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={panelTab === "checks"} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "pr"}>
                <SurfaceBoundary id="panel.pr" surface="Right sidebar: pull request" resetKey={current?.path} titleKey="boundary.panel.title">
                  {current ? (
                    <ReviewPanel key={current.path} api={api} worktree={current.path} prs={prs} comments={prComments} sessions={sessions} onSendComments={sendComments} visible={rightOpen && panelTab === "pr"} onFix={(check) => fixCheck(check)} onFixAll={(checks) => fixChecks(checks)} onOpenFile={(rel) => openFile(current.path, rel)} onOpenPage={() => live.openPrPage()} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "issues"}>
                <SurfaceBoundary id="panel.issues" surface="Right sidebar: issues" resetKey={currentRepo?.id} titleKey="boundary.panel.title">
                  {currentRepo && !currentRepo.missing ? (
                    <IssuesPanel key={`${currentRepo.id}:${issuesGit.preset}`} initialPreset={issuesGit.preset} api={api} repoId={currentRepo.id} onStart={(d) => void startFromIssue(currentRepo.id, d.issue, d)} />
                  ) : (
                    <p className="ws-empty">{t("workspace.panel.empty")}</p>
                  )}
                </SurfaceBoundary>
              </div>
              <div className="ws-panel-body" role="tabpanel" hidden={panelTab !== "ports"}>
                <PortsPanel api={api} store={ports} active={current?.path ?? null} visible={rightOpen && panelTab === "ports" && view === "workspace"} />
              </div>
            </RightPanel>
          </div>
        </div>
    </>
  );
}
