import type { FsEvent } from "@/api";
import { parentOf } from "./treeActions";

/**
 * The loaded folders whose listing an event batch changed: the parent of each created or deleted
 * entry. An update to a file changes no listing. An overflow means the batch is incomplete, so
 * every loaded folder is read again.
 */
export function dirsToReload(events: FsEvent[], loaded: ReadonlySet<string>): string[] | "all" {
  const out = new Set<string>();
  for (const e of events) {
    if (e.kind === "overflow") return "all";
    if (e.kind === "update") continue;
    const dir = parentOf(e.rel);
    if (loaded.has(dir)) out.add(dir);
  }
  return [...out];
}
