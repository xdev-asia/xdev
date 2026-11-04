import type { VaultView } from "@/api";

export type PickInput = {
  vaults: VaultView[];
  /** The path of the source shown last, from `localStorage["xdev.docs.source"]`. */
  saved: string | null;
  /** The project that was current when `saved` was stored. */
  savedRepo: string | null;
  /** The project that is current now. */
  repoId: string | null;
};

// Two spellings of one folder match: `/` as the separator, no trailing one, lower case.
function key(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

/**
 * Which docs source to show. In order:
 * 1. The current project changed since `savedRepo`: that project's own docs.
 * 2. Else the `saved` source, if it is still listed.
 * 3. Else the first listed source whose folder exists.
 * 4. Else `null`.
 * A source whose folder is gone is never picked: it cannot be opened.
 */
export function pickDocsSource({ vaults, saved, savedRepo, repoId }: PickInput): VaultView | null {
  if (repoId !== null && repoId !== savedRepo) {
    const own = vaults.find((v) => v.kind === "repo" && v.repoId === repoId && v.exists);
    if (own) return own;
  }
  if (saved !== null) {
    const wanted = key(saved);
    const kept = vaults.find((v) => v.exists && key(v.path) === wanted);
    if (kept) return kept;
  }
  return vaults.find((v) => v.exists) ?? null;
}
