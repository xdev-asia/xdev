import { useRef, useState, useSyncExternalStore } from "react";
import { toApiError, type Api, type ApiError, type BaseDrift, type CreateRequest, type DetailsPatch, type Issue, type IssueDetail, type Linked, type MrSummary, type PrSummary, type RepoView, type WorkStatus, type WorktreeView } from "@/api";
import type { useI18n } from "@/i18n";
import { issuePrompt, issueWorkItem, issueWorktreeName, uniqueWorktreeName } from "@/issues/issueStart";
import { effectiveIssueCommand, issueTemplateVars, renderIssueCommand } from "@/issues/issueTemplate";
import { baseBehindToast } from "@/workspace/baseBehind";
import type { CreateExtra, CreateTab } from "@/workspace/CreateWorktreeDialog";
import { mrWorkItem, mrWorktreeName, prWorkItem, prWorktreeName } from "@/workspace/createSource";
import { failedLinks } from "@/workspace/linkReport";
import { PendingCreates, type CreateArgs } from "@/workspace/pendingCreates";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { SetupGate } from "@/workspace/setupGate";
import type { Creating } from "@/workspace/shellModel";
import { pushToast } from "@/workspace/toastStore";

type T = ReturnType<typeof useI18n>["t"];

/** New worktrees: the create dialog, the creates still running, and the first agent a new worktree opens. */
export function useShellCreate(o: {
  api: Api;
  t: T;
  sessions: Sessions | null;
  gate: SetupGate;
  repos: RepoView[] | null;
  currentRepo: RepoView | null;
  all: WorktreeView[];
  setupRan: { current: Set<string> };
  load(): Promise<unknown>;
  setNotice(code: ApiError["code"] | undefined): void;
  select(wt: WorktreeView): void;
  openSettings(section: string): void;
  setupAfterCreate(path: string, repoId: string): Promise<void>;
}) {
  const { api, t, sessions, gate, repos, currentRepo, all, setupRan, load, setNotice, select, openSettings, setupAfterCreate } = o;
  const [creating, setCreating] = useState<Creating | null>(null);
  // The tab the create dialog was last on, for the next opening of this shell.
  const createTab = useRef<CreateTab>("name");
  // Creates run after the dialog has closed; what a finished one does is read from this render.
  const afterCreate = useRef<{ api: Api; created(wt: WorktreeView, args: CreateArgs): void; reload(): void; linked(shared: Linked[]): void; behind(drift: BaseDrift): void }>({ api, created() {}, reload() {}, linked() {}, behind() {} });
  const [pending] = useState(
    () =>
      new PendingCreates({
        create: (repoId, name, from, request) => afterCreate.current.api.worktreeCreate(repoId, name, from, request).then((made) => {
          afterCreate.current.linked(made.shared);
          if (made.baseBehind) afterCreate.current.behind(made.baseBehind);
          return made.worktree;
        }),
        // Cancel was the go-ahead; a fresh worktree is clean, so its branch goes too.
        remove: (path, force) => afterCreate.current.api.worktreeRemove(path, force, true).finally(() => afterCreate.current.reload()),
        onCreated: (wt, args) => afterCreate.current.created(wt, args),
        discard: (repoId, branch) => afterCreate.current.api.prBranchDiscard(repoId, branch),
      }),
  );
  useSyncExternalStore(
    (fn) => pending.subscribe(fn),
    () => pending.version,
  );

  function startCreate(repoId?: string, name?: string, status?: WorkStatus | null): void {
    const usable = repos?.filter((r) => !r.missing) ?? [];
    const id = repoId ?? (currentRepo && !currentRepo.missing ? currentRepo.id : usable[0]?.id);
    if (!id) return;
    setCreating({ repoId: id, name, status, agents: [], defaultAgent: null });
    // The agent choice arrives a moment later; the dialog is already open.
    void api
      .profiles()
      .then((v) => ({
        agents: v.profiles.filter((p) => p.profile.enabled && p.installed).map((p) => ({ id: p.profile.id, name: p.profile.name })),
        defaultAgent: v.defaultAgent as string | null,
      }))
      .then((choice) => setCreating((c) => (c ? { ...c, ...choice } : c)))
      .catch(() => {});
  }

  // The dialog closes at once; the create runs as a row in the list until it finishes or fails.
  function create(repoId: string, name: string, from: string | null, extra?: CreateExtra, request?: CreateRequest, keepOpen = false, discardBranch?: string): void {
    if (!keepOpen) setCreating(null);
    pending.start({ repoId, name, from, ...(extra ? { extra } : {}), ...(request ? { request } : {}), ...(discardBranch ? { discardBranch } : {}) });
  }

  // The issue becomes the worktree: named from it, linked as its work item, sent to the default agent.
  async function startFromIssue(repoId: string, issue: Issue, detail?: IssueDetail): Promise<void> {
    try {
      const full = detail ?? (await api.issueView(repoId, issue.number).catch(() => ({ issue, body: "", comments: [] })));
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(issueWorktreeName(issue), taken);
      const view = await api.profiles().catch(() => null);
      // The repo's issue command, when it has one, in place of the built-in prompt.
      const shared = repo ? await api.repoHooks(repo.path).catch(() => null) : null;
      const template = effectiveIssueCommand(repo?.localIssueCommand ?? "", shared);
      create(repoId, name, null, {
        title: null,
        agent: view?.defaultAgent ?? null,
        setDefault: false,
        parent: null,
        item: issueWorkItem(issue),
        prompt: template === null ? issuePrompt(full, t) : renderIssueCommand(template, issueTemplateVars(full, repo?.shortName ?? "", t)),
      });
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // The pull request becomes the worktree: its branch is put on a new worktree, linked as its work item, sent to the default agent.
  async function startFromPr(repoId: string, pr: PrSummary): Promise<void> {
    try {
      const { branch, fetched } = await api.prBranch(repoId, pr.number);
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(prWorktreeName(pr), taken);
      const view = await api.profiles().catch(() => null);
      create(repoId, name, null, { title: pr.title, agent: view?.defaultAgent ?? null, setDefault: false, parent: null, item: prWorkItem(pr) }, { existing: branch, sparse: [] }, false, fetched ? branch : undefined);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // A merge request starts a worktree the way a pull request does, on the branch `gitlab_mr_branch` puts in place.
  async function startFromMr(repoId: string, mr: MrSummary): Promise<void> {
    try {
      const { branch, fetched } = await api.gitlabMrBranch(repoId, mr.iid);
      const repo = repos?.find((r) => r.id === repoId);
      const taken = new Set((repo?.worktrees ?? []).flatMap((w) => [w.name, w.branch ?? ""]));
      const name = uniqueWorktreeName(mrWorktreeName(mr), taken);
      const view = await api.profiles().catch(() => null);
      create(repoId, name, null, { title: mr.title, agent: view?.defaultAgent ?? null, setDefault: false, parent: null, item: mrWorkItem(mr) }, { existing: branch, sparse: [] }, false, fetched ? branch : undefined);
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  async function created(wt: WorktreeView, args: CreateArgs): Promise<void> {
    const extra = args.extra;
    if (extra) await applyCreateExtra(wt.path, extra);
    await load();
    setupRan.current.add(wt.path);
    await setupAfterCreate(wt.path, args.repoId);
    // Dialog: the agent it picked, or none. No dialog: the default agent.
    await openDefaultAgent(wt.path, extra ? extra.agent : undefined, extra?.prompt);
    select(wt);
  }
  afterCreate.current = { api, created: (wt, args) => void created(wt, args), reload: () => void load(), linked: reportLinks, behind: (drift) => void pushToast(baseBehindToast(drift, api, t)) };

  // Shared paths that did not link are said once, with the reason; the worktree is made all the same.
  function reportLinks(shared: Linked[]): void {
    const failed = failedLinks(shared);
    if (failed.length > 0) pushToast({ text: t("repoFile.linkFailed", { paths: failed.join("\n") }), ttlMs: 0 });
  }

  // The worktree is made; what the dialog added goes in one details call, and a new default agent is kept.
  async function applyCreateExtra(path: string, extra: CreateExtra): Promise<void> {
    const patch: DetailsPatch = {};
    if (extra.title !== null) patch.title = extra.title;
    if (extra.parent !== null) patch.parent = extra.parent;
    if (extra.item !== null) patch.item = extra.item;
    if (extra.note) patch.comment = extra.note;
    if (extra.status) patch.status = extra.status;
    try {
      if (Object.keys(patch).length > 0) await api.worktreeDetails(path, patch);
      if (extra.setDefault && extra.agent !== null) {
        const view = await api.profiles();
        if (view.defaultAgent !== extra.agent) await api.profilesDefaults(view.approvals, extra.agent, view.defaultShell);
      }
    } catch (e) {
      setNotice(toApiError(e).code);
    }
  }

  // A new worktree starts with the agent picked for it, else the resolved default agent; with no
  // agent at all, the default shell, and nothing is typed into it. A picked agent that is off or not
  // installed opens nothing, and a toast says why: another agent never takes its place or its prompt.
  async function openDefaultAgent(path: string, pick?: string | null, prompt?: string, o: { id?: string; account?: string } = {}): Promise<Tab | null> {
    if (!sessions || pick === null) return null;
    try {
      const view = await api.profiles();
      const usable = (id: string) => view.profiles.some((p) => p.profile.id === id && p.profile.enabled && p.installed);
      if (pick !== undefined && !usable(pick)) {
        const name = view.profiles.find((p) => p.profile.id === pick)?.profile.name ?? pick;
        pushToast({
          text: t("workspace.agentUnusable", { name }),
          actions: [{ label: t("workspace.agentPicker.manage"), run: () => openSettings("agents") }],
        });
        return null;
      }
      const agent = pick ?? view.resolvedDefault;
      const shell = view.shells.some((s) => s.id === view.defaultShell) ? view.defaultShell : view.shells[0]?.id;
      const id = agent ?? shell;
      if (!id) return null;
      // The prompt goes with the agent tab: on its command line, or typed once it started.
      let opened: Tab | null = null;
      const launch = (): void => void (opened = sessions.open(path, id, o.account ?? null, undefined, { ...(agent && prompt ? { prompt } : {}), ...(o.id ? { id: o.id } : {}) }));
      // With the repo set to wait, the tab opens when the setup tab has exited.
      if (!gate.defer(path, launch)) launch();
      return opened;
    } catch {
      // The worktree is made; it just opens empty.
      return null;
    }
  }

  // The Tasks app starts an agent on a task: in a worktree it made or the current one. Resolves with the tab, to link it.
  async function startBoardAgent(req: { worktree: string; agent: string | null; prompt: string }): Promise<{ tabId: string; tabTitle: string } | null> {
    if (!all.some((w) => w.path === req.worktree)) await load();
    const tab = await openDefaultAgent(req.worktree, req.agent ?? undefined, req.prompt);
    return tab ? { tabId: tab.id, tabTitle: tab.title ?? tab.profileId } : null;
  }

  return {
    creating, setCreating, createTab, pending, startCreate, create, startFromIssue, startFromPr, startFromMr, openDefaultAgent, startBoardAgent,
  };
}
