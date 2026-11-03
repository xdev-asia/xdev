import type { Api, ApiError, RepoView } from "@/api";
import { toApiError } from "@/api";

/** What forgetting a repo needs from the window. */
export interface RemoveRepoDeps {
  forget: Api["repoForget"];
  /** Closes the terminals of a worktree path. */
  closeWorktree(path: string): Promise<void> | void;
}

/**
 * Forgets `repo` in xDev, then closes the terminals of each of its worktrees. Nothing is deleted on
 * disk. When forgetting fails the tabs stay open and the error code is returned.
 */
export async function removeRepo(deps: RemoveRepoDeps, repo: RepoView): Promise<ApiError["code"] | null> {
  try {
    await deps.forget(repo.id);
  } catch (e) {
    return toApiError(e).code;
  }
  for (const wt of repo.worktrees) await deps.closeWorktree(wt.path);
  return null;
}
