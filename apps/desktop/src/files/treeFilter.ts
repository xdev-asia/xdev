import { fileName } from "./fileTabs";
import { parentOf } from "./treeActions";

export const FILTER_LIMIT = 200;

export interface FilterHit {
  rel: string;
  name: string;
  /** The folder the file is in; empty at the root. */
  dir: string;
}

/**
 * Case-insensitive substring match of `query` against the file name only (not the folders above it).
 * Names that start with the query come first, then the rest, each in the order of `files`.
 * A blank query matches nothing; the caller shows the tree then.
 */
export function matchFiles(files: string[], query: string, limit = FILTER_LIMIT): { hits: FilterHit[]; more: boolean } {
  const q = query.trim().toLowerCase();
  if (q === "") return { hits: [], more: false };
  const first: FilterHit[] = [];
  const rest: FilterHit[] = [];
  for (const rel of files) {
    const name = fileName(rel);
    const at = name.toLowerCase().indexOf(q);
    if (at < 0) continue;
    (at === 0 ? first : rest).push({ rel, name, dir: parentOf(rel) });
  }
  const all = first.concat(rest);
  return { hits: all.slice(0, limit), more: all.length > limit };
}
