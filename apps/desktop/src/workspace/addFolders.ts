import { toApiError, type Api, type ApiError } from "@/api";

export interface AddFoldersResult {
  added: Awaited<ReturnType<Api["repoAdd"]>>[];
  failed: { path: string; code: ApiError["code"] }[];
}

/** Adds the folders one after another (the repo store is one file), keeping the ones that failed with their error code. */
export async function addRepoFolders(api: Pick<Api, "repoAdd">, paths: readonly string[]): Promise<AddFoldersResult> {
  const result: AddFoldersResult = { added: [], failed: [] };
  for (const path of paths) {
    try {
      result.added.push(await api.repoAdd(path));
    } catch (e) {
      result.failed.push({ path, code: toApiError(e).code });
    }
  }
  return result;
}

/** What to tell the user: the error code of the one folder that failed, a summary toast for several, or nothing. */
export function addFoldersNotice(result: AddFoldersResult, total: number): { code: ApiError["code"] } | { toast: { added: number; total: number; failed: number } } | null {
  if (result.failed.length === 0) return null;
  if (total === 1) return { code: result.failed[0].code };
  return { toast: { added: result.added.length, total, failed: result.failed.length } };
}
