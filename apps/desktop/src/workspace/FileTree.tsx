import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type DirListing, type WorktreeChange } from "@/api";
import { useI18n } from "@/i18n";

// Git's own letters, so they read the same in every language. A deleted file is not on disk, so
// the tree never meets one.
const MARK: Partial<Record<WorktreeChange["kind"], string>> = { added: "A", modified: "M" };

// A folder as read, or why it could not be.
type Folder = { listing: DirListing } | { error: string };

type Row =
  | { type: "dir"; path: string; name: string; depth: number; open: boolean; changed: boolean }
  | { type: "file"; path: string; name: string; depth: number; kind?: WorktreeChange["kind"] }
  | { type: "note"; path: string; depth: number; note: "loading" | "empty" | "truncated" | "error" };

const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/**
 * The visible rows, folders first as the listing gives them. A folder not read yet shows a loading
 * row once it is open; a cut listing ends in a note.
 */
export function treeRows(folders: Record<string, Folder>, open: string[], changes: WorktreeChange[]): Row[] {
  const kinds = new Map(changes.map((c) => [c.path, c.kind]));
  const changedDirs = new Set<string>();
  for (const { path } of changes) {
    for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) changedDirs.add(path.slice(0, i));
  }
  const rows: Row[] = [];
  const walk = (dir: string, depth: number): void => {
    const folder = folders[dir];
    const note = (kind: Extract<Row, { type: "note" }>["note"]) => rows.push({ type: "note", path: `${dir}\0${kind}`, depth, note: kind });
    if (!folder) return void note("loading");
    if ("error" in folder) return void note("error");
    for (const entry of folder.listing.entries) {
      const path = join(dir, entry.name);
      if (!entry.dir) {
        rows.push({ type: "file", path, name: entry.name, depth, kind: kinds.get(path) });
        continue;
      }
      const expanded = open.includes(path);
      rows.push({ type: "dir", path, name: entry.name, depth, open: expanded, changed: changedDirs.has(path) });
      if (expanded) walk(path, depth + 1);
    }
    if (folder.listing.truncated) note("truncated");
    else if (folder.listing.entries.length === 0 && dir !== "") note("empty");
  };
  walk("", 0);
  return rows;
}

/**
 * One worktree's files, a folder level at a time. A folder is read when first opened and kept until
 * the worktree's change list is read again; then the shown folders are read afresh.
 */
export function FileTree(props: {
  api: Api;
  worktree: string;
  changes: WorktreeChange[];
  onOpen: (file: string) => void;
}): JSX.Element {
  const { api, worktree, changes, onOpen } = props;
  const { t } = useI18n();
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [open, setOpen] = useState<string[]>([]);
  // Bumped when the cache is dropped, so an answer to an older question is not kept.
  const epoch = useRef(0);
  // Folders asked for and not answered yet, so a second click does not ask again.
  const asked = useRef(new Set<string>());
  const openNow = useRef(open);
  openNow.current = open;

  function read(dir: string): void {
    if (asked.current.has(dir)) return;
    asked.current.add(dir);
    const seq = epoch.current;
    const keep = (folder: Folder) => {
      if (seq !== epoch.current) return;
      asked.current.delete(dir);
      setFolders((all) => ({ ...all, [dir]: folder }));
    };
    api.worktreeListDir(worktree, dir).then(
      (listing) => keep({ listing }),
      (e) => keep({ error: toApiError(e).code }),
    );
  }

  useEffect(() => {
    epoch.current++;
    asked.current.clear();
    const shown = ["", ...openNow.current];
    // What is shown stays until its new reading arrives; a closed folder is read again when opened.
    setFolders((all) => Object.fromEntries(Object.entries(all).filter(([dir]) => shown.includes(dir))));
    for (const dir of shown) read(dir);
  }, [api, worktree, changes]);

  function toggle(dir: string): void {
    const closing = open.includes(dir);
    setOpen(closing ? open.filter((d) => d !== dir) : [...open, dir]);
    if (!closing && !folders[dir]) read(dir);
  }

  const kinds = new Map(changes.map((c) => [c.path, c.kind]));
  return (
    <div className="ws-tree ws-mono" role="tree" aria-label={t("workspace.files.tree")}>
      {treeRows(folders, open, changes).map((row) => {
        const indent = { paddingLeft: `calc(var(--tree-indent) * ${row.depth} + var(--tree-pad))` };
        if (row.type === "note") {
          return (
            <div key={row.path} className="ws-tree-note" role="treeitem" aria-level={row.depth + 1} aria-disabled="true" style={indent} title={t(`workspace.files.${row.note}`)}>
              {row.note === "truncated" ? "…" : t(`workspace.files.${row.note}`)}
            </div>
          );
        }
        if (row.type === "dir") {
          return (
            <button
              key={row.path}
              type="button"
              role="treeitem"
              className="ws-tree-row"
              aria-level={row.depth + 1}
              aria-expanded={row.open}
              title={row.path}
              style={indent}
              onClick={() => toggle(row.path)}
            >
              <svg className="ws-tree-icon" data-open={row.open} aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
              </svg>
              <span className="ws-tree-name">{row.name}</span>
              {row.changed && <span className="ws-tree-dot" aria-hidden="true" />}
            </button>
          );
        }
        const mark = row.kind ? MARK[row.kind] : undefined;
        const body = (
          <>
            <svg className="ws-tree-icon" aria-hidden="true" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />
            </svg>
            <span className="ws-tree-name">{row.name}</span>
            {mark && row.kind && (
              <span className="ws-tree-mark" data-kind={row.kind} title={t(`changes.kind.${row.kind}`)}>
                {mark}
              </span>
            )}
          </>
        );
        // Only a changed file has a diff to open.
        return kinds.has(row.path) ? (
          <button key={row.path} type="button" role="treeitem" className="ws-tree-row" aria-level={row.depth + 1} title={row.path} style={indent} onClick={() => onOpen(row.path)}>
            {body}
          </button>
        ) : (
          <div key={row.path} role="treeitem" className="ws-tree-row" aria-level={row.depth + 1} title={row.path} style={indent}>
            {body}
          </div>
        );
      })}
    </div>
  );
}
