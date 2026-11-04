import { toApiError, type Api, type WorktreeView, type GitSettings } from "@/api";
import type { ToastInput } from "./toastStore";
import type { Sessions } from "./sessions";

// A prompt the session index has not read yet answers `bad_name`; the next prompt may find it.
const NOT_READ_TRIES = 3;

/**
 * Whether a worktree may be renamed from its first prompt: its name was picked by the app, it is on a
 * branch, the setting is on, and this run has not tried it yet. A branch that is already pushed is
 * refused by the backend, which is the only one that knows.
 */
export function shouldRename(wt: WorktreeView, git: GitSettings, tried: ReadonlySet<string>): boolean {
  return wt.autoName && git.autoRenameBranch && !wt.primary && !wt.detached && wt.branch !== null && !tried.has(wt.path);
}

export interface AutoRenameDeps {
  api: Api;
  sessions: Sessions;
  /** The worktrees now listed. */
  worktrees(): readonly WorktreeView[];
  t(key: string, vars?: Record<string, string | number>): string;
  /** Reloads the workspace list after a rename. */
  reload(): void;
  toast(toast: ToastInput): void;
}

/** The part of a branch name after its prefix. */
const leafOf = (branch: string): string => branch.slice(branch.lastIndexOf("/") + 1);

/**
 * Names the branch of a worktree from the first prompt its agent receives: the first agent tab of an
 * auto-named worktree to be working with a session id asks for a suggestion, renames, and says so
 * with an Undo. Once per worktree per run; any failure is silent (logged once). Returns the stop.
 */
export function startAutoRename(deps: AutoRenameDeps): () => void {
  const { api, sessions, t } = deps;
  const tried = new Set<string>();
  const unread = new Map<string, number>();
  const logged = new Set<string>();
  let stopped = false;

  const log = (path: string, e: unknown): void => {
    if (logged.has(path)) return;
    logged.add(path);
    console.warn(`auto rename of ${path} failed:`, toApiError(e).code);
  };

  async function undo(path: string, oldBranch: string): Promise<void> {
    try {
      await api.worktreeRenameBranch(path, leafOf(oldBranch));
      // The title came from the new name; it goes with it.
      await api.worktreeDetails(path, { title: null });
      deps.reload();
    } catch (e) {
      deps.toast({ text: t(`error.${toApiError(e).code}`) });
    }
  }

  async function run(wt: WorktreeView, session: string): Promise<void> {
    const path = wt.path;
    const old = wt.branch ?? "";
    try {
      const git = await api.gitSettings();
      if (!shouldRename(wt, git, new Set())) return;
      const name = await api.worktreeSuggestBranch(path, session);
      // The suggestion can take a while; a name the user gave in the meantime stays.
      const now = deps.worktrees().find((w) => w.path === path);
      if (stopped || !now?.autoName || now.branch !== wt.branch) return;
      const view = await api.worktreeRenameBranch(path, name);
      if (stopped) return;
      deps.reload();
      deps.toast({
        text: t("branchRename.toast", { branch: view.branch ?? name }),
        actions: [{ label: t("branchRename.undo"), run: () => void undo(path, old) }],
      });
    } catch (e) {
      const code = toApiError(e).code;
      // Pushed in the meantime: nothing to say. The index not having the prompt yet: try the next one.
      if (code === "branch_pushed") return;
      if (code === "bad_name") {
        const n = (unread.get(path) ?? 0) + 1;
        unread.set(path, n);
        if (n < NOT_READ_TRIES) tried.delete(path);
        return;
      }
      log(path, e);
    }
  }

  const look = (): void => {
    if (stopped) return;
    for (const wt of deps.worktrees()) {
      // The setting is read when the run starts; here only what the list says.
      if (!wt.autoName || wt.primary || wt.detached || wt.branch === null || tried.has(wt.path)) continue;
      const tab = sessions.tabs(wt.path).find((x) => x.agent && x.status === "working" && x.agentSession !== null);
      if (!tab?.agentSession) continue;
      tried.add(wt.path);
      void run(wt, tab.agentSession);
    }
  };
  const off = sessions.subscribe(look);
  return () => {
    stopped = true;
    off();
  };
}
