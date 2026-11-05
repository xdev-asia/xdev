import { Banner, Icon } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type DirListing, type FsEvent, type WorktreeChange } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NameDialog } from "@/files/NameDialog";
import { fileName, fileTabs } from "@/files/fileTabs";
import { openFile } from "@/files/openFile";
import { dirsToReload, drain, type WatchQueue } from "@/files/treeRefresh";
import { copyAbsolute, copyRelative, createEntry, deleteEntry, parentOf, renameEntry, type TreeIo } from "@/files/treeActions";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { pushToast } from "./toastStore";
import type { WatchHealth } from "./worktreeWatch";

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
 * The rows of the folders already loaded whose names match `query`, with the folders above a match
 * kept so it stays reachable. An empty query keeps every row.
 */
export function filterRows(rows: Row[], query: string): Row[] {
  const q = query.trim().toLowerCase();
  if (q === "") return rows;
  const hits = rows.filter((r) => r.type !== "note" && r.name.toLowerCase().includes(q));
  const keep = new Set<string>();
  for (const r of hits) {
    keep.add(r.path);
    for (let i = r.path.indexOf("/"); i >= 0; i = r.path.indexOf("/", i + 1)) keep.add(r.path.slice(0, i));
  }
  return rows.filter((r) => r.type !== "note" && keep.has(r.path));
}

// What a menu or dialog is about: a row, or the tree's empty space (the worktree root).
type Target = { rel: string; dir: boolean };
type Ask = { kind: "newFile" | "newFolder" | "rename"; dir: string; rel?: string } | { kind: "delete"; rel: string };

/**
 * One worktree's files, a folder level at a time. A folder is read when first opened and kept until
 * the worktree's change list is read again; then the shown folders are read afresh.
 */
export function FileTree(props: {
  api: Api;
  worktree: string;
  changes: WorktreeChange[];
  onOpen: (file: string) => void;
  /** Opens the search in files; the link is off until something handles it. */
  onSearch?: () => void;
  /** The disk events of the shown worktree; each batch is applied once. Held while a name dialog is open. */
  queue?: WatchQueue | null;
  /** How watching the disk goes; `limit` shows why live updates stopped. */
  watchHealth?: WatchHealth;
}): JSX.Element {
  const { api, worktree, changes, onOpen, onSearch, queue = null } = props;
  const { t } = useI18n();
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target | null } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
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
  }, [api, worktree, changes, refresh]);

  // Disk events wait here while a name dialog is open, so its sibling check keeps a steady list.
  const pending = useRef<FsEvent[]>([]);
  const seen = useRef(0);
  const naming = ask !== null && ask.kind !== "delete";
  useEffect(() => {
    if (queue) {
      const next = drain(queue, worktree, seen.current);
      seen.current = next.seen;
      pending.current.push(...next.events);
    }
    if (naming || pending.current.length === 0) return;
    const batch = pending.current;
    pending.current = [];
    const dirs = dirsToReload(batch, new Set(["", ...openNow.current]));
    if (dirs === "all") return void setRefresh((n) => n + 1);
    for (const dir of dirs) {
      asked.current.delete(dir);
      read(dir);
    }
  }, [queue, naming]);

  function toggle(dir: string): void {
    const closing = open.includes(dir);
    setOpen(closing ? open.filter((d) => d !== dir) : [...open, dir]);
    if (!closing && !folders[dir]) read(dir);
  }

  const io = (): TreeIo => ({ api, store: fileTabs, worktree, t });

  // Only the folder that changed is read again; its old rows stay until the new ones arrive.
  function reload(dir: string | null): void {
    if (dir === null) return;
    asked.current.delete(dir);
    read(dir);
    if (dir !== "" && !openNow.current.includes(dir)) setOpen((all) => [...all, dir]);
  }

  const namesIn = (dir: string): string[] => {
    const folder = folders[dir];
    return folder && "listing" in folder ? folder.listing.entries.map((e) => e.name) : [];
  };

  async function openOnHost(rel: string): Promise<void> {
    try {
      await api.worktreeOpenFileOnHost(worktree, rel, null, null);
    } catch (e) {
      pushToast({ id: "files-open-host", text: t(toApiError(e).code === "no_web_remote" ? "gitHistory.noWebRemote" : "files.openOnHostFailed") });
    }
  }

  function menuItems(target: Target | null): MenuItem[] {
    const dirOf = target === null ? "" : target.dir ? target.rel : parentOf(target.rel);
    const items: MenuItem[] = [];
    if (target && !target.dir) items.push({ id: "open", labelKey: "files.menu.open", run: () => openFile({ worktree, rel: target.rel }) });
    if (target) {
      items.push(
        { id: "copyPath", labelKey: "files.menu.copyPath", run: () => void copyAbsolute(io(), target.rel) },
        { id: "copyRel", labelKey: "files.menu.copyRelativePath", run: () => void copyRelative(target.rel) },
        { id: "sep1", labelKey: "", kind: "separator" },
      );
    }
    items.push(
      { id: "newFile", labelKey: "files.menu.newFile", run: () => setAsk({ kind: "newFile", dir: dirOf }) },
      { id: "newFolder", labelKey: "files.menu.newFolder", run: () => setAsk({ kind: "newFolder", dir: dirOf }) },
    );
    if (target) {
      items.push(
        { id: "rename", labelKey: "files.menu.rename", run: () => setAsk({ kind: "rename", dir: parentOf(target.rel), rel: target.rel }) },
        { id: "delete", labelKey: "files.menu.delete", danger: true, run: () => setAsk({ kind: "delete", rel: target.rel }) },
        { id: "sep2", labelKey: "", kind: "separator" },
        { id: "reveal", labelKey: "files.menu.reveal", run: () => void api.fileReveal(worktree, target.rel).catch(() => undefined) },
      );
      if (!target.dir) items.push({ id: "openOnHost", labelKey: "files.menu.openOnHost", run: () => void openOnHost(target.rel) });
    }
    return items;
  }

  const onMenu = (e: MouseEvent, target: Target | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const rows = filterRows(treeRows(folders, open, changes), filter);
  const kinds = new Map(changes.map((c) => [c.path, c.kind]));
  return (
    <div className="ws-tree-wrap">
      <div className="ws-tree-tools">
        <input
          className="ws-tree-filter"
          type="search"
          data-field="filter"
          placeholder={t("files.tree.filter")}
          aria-label={t("files.tree.filter")}
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <button type="button" className="ws-tree-tool" data-action="refresh" title={t("files.tree.refresh")} aria-label={t("files.tree.refresh")} onClick={() => setRefresh((n) => n + 1)}>
          ↻
        </button>
        <button type="button" className="ws-tree-tool" data-action="collapse" title={t("files.tree.collapseAll")} aria-label={t("files.tree.collapseAll")} onClick={() => setOpen([])}>
          ⊟
        </button>
        <button type="button" className="ws-tree-tool" data-action="search" disabled={!onSearch} onClick={onSearch}>
          {t("files.tree.searchInFiles")}
        </button>
      </div>
      {props.watchHealth === "limit" && <Banner title={t("files.watch.limit.title")}>{t("files.watch.limit.body")}</Banner>}
    <div className="ws-tree ws-mono" role="tree" aria-label={t("workspace.files.tree")} onContextMenu={(e) => onMenu(e as unknown as MouseEvent, null)}>
      {rows.map((row) => {
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
              onContextMenu={(e) => onMenu(e as unknown as MouseEvent, { rel: row.path, dir: true })}
            >
              <Icon name="folder" className="ws-tree-icon" data-open={row.open} size={13} />
              <span className="ws-tree-name">{row.name}</span>
              {row.changed && <span className="ws-tree-dot" aria-hidden="true" />}
            </button>
          );
        }
        const mark = row.kind ? MARK[row.kind] : undefined;
        const body = (
          <>
            <Icon name="file" className="ws-tree-icon" size={13} />
            <span className="ws-tree-name">{row.name}</span>
            {mark && row.kind && (
              <span className="ws-tree-mark" data-kind={row.kind} title={t(`changes.kind.${row.kind}`)}>
                {mark}
              </span>
            )}
          </>
        );
        // A changed file opens its diff on a click; every file opens in an editor on a double click.
        const changed = kinds.has(row.path);
        return (
          <button
            key={row.path}
            type="button"
            role="treeitem"
            className="ws-tree-row"
            aria-level={row.depth + 1}
            title={row.path}
            style={indent}
            onClick={() => (changed ? onOpen(row.path) : openFile({ worktree, rel: row.path }))}
            onDoubleClick={() => openFile({ worktree, rel: row.path })}
            onContextMenu={(e) => onMenu(e as unknown as MouseEvent, { rel: row.path, dir: false })}
          >
            {body}
          </button>
        );
      })}
    </div>
      {menu && <ContextMenu at={menu} items={menuItems(menu.target)} onClose={() => setMenu(null)} />}
      {ask && ask.kind !== "delete" && (
        <NameDialog
          title={t(`files.name.${ask.kind}`)}
          initial={ask.rel ? fileName(ask.rel) : ""}
          siblings={namesIn(ask.dir).filter((n) => n !== (ask.rel ? fileName(ask.rel) : null))}
          confirmLabel={t(ask.kind === "rename" ? "files.name.renameConfirm" : "files.name.createConfirm")}
          onCancel={() => setAsk(null)}
          onConfirm={(name) => {
            const a = ask;
            setAsk(null);
            const done = a.kind === "rename" ? renameEntry(io(), a.rel!, name) : createEntry(io(), a.dir, name, a.kind === "newFolder");
            void done.then(reload);
          }}
        />
      )}
      <ConfirmDialog
        open={ask?.kind === "delete"}
        title={t("files.delete.title", { name: ask?.kind === "delete" ? fileName(ask.rel) : "" })}
        body={t("files.delete.body")}
        confirmLabel={t("files.delete.confirm")}
        onCancel={() => setAsk(null)}
        onConfirm={() => {
          const a = ask;
          setAsk(null);
          if (a?.kind === "delete") void deleteEntry(io(), a.rel).then(reload);
        }}
      />
    </div>
  );
}
