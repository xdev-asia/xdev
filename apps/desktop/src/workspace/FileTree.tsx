import { Banner, Icon } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX, DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { toApiError, type Api, type DirListing, type FileList, type FsEvent, type WorktreeChange } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { NameDialog } from "@/files/NameDialog";
import { fileName, fileTabs } from "@/files/fileTabs";
import { openFile } from "@/files/openFile";
import { isRemoteWorktree, listingFromFiles } from "@/files/remoteTree";
import { dirsToReload, drain, type WatchQueue } from "@/files/treeRefresh";
import { canMove, copyAbsolute, copyRelative, createEntry, deleteEntry, findInFolder, moveEntry, parentOf, renameEntry, treeMenuItems, type TreeIo } from "@/files/treeActions";
import { matchFiles } from "@/files/treeFilter";
import { NAV_KEYS, navigate, type NavKey, type NavRow } from "@/files/treeNav";
import { loadReveal, loadShowIgnored, onTreeReveal, revealOpen, saveReveal, saveShowIgnored } from "@/files/treeReveal";
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
  | { type: "dir"; path: string; name: string; depth: number; open: boolean; changed: boolean; ignored: boolean }
  | { type: "file"; path: string; name: string; depth: number; kind?: WorktreeChange["kind"]; ignored: boolean }
  | { type: "note"; path: string; depth: number; note: "loading" | "empty" | "truncated" | "error" };

// How long a revealed row stays tinted; the animation in workspace.css lasts as long.
const FLASH_MS = 1000;

const join = (dir: string, name: string): string => (dir === "" ? name : `${dir}/${name}`);

/**
 * The visible rows, folders first as the listing gives them. A folder not read yet shows a loading
 * row once it is open; a cut listing ends in a note. What git ignores is left out when `showIgnored` is off.
 */
export function treeRows(folders: Record<string, Folder>, open: string[], changes: WorktreeChange[], showIgnored = true): Row[] {
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
      if (entry.ignored && !showIgnored) continue;
      const path = join(dir, entry.name);
      if (!entry.dir) {
        rows.push({ type: "file", path, name: entry.name, depth, kind: kinds.get(path), ignored: entry.ignored });
        continue;
      }
      const expanded = open.includes(path);
      rows.push({ type: "dir", path, name: entry.name, depth, open: expanded, changed: changedDirs.has(path), ignored: entry.ignored });
      if (expanded) walk(path, depth + 1);
    }
    if (folder.listing.truncated) note("truncated");
    else if (folder.listing.entries.length === 0 && dir !== "") note("empty");
  };
  walk("", 0);
  return rows;
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
  /** Shows the search panel; the link is off until something handles it. */
  onSearch?: () => void;
  /** Opens a terminal tab in the folder `dir` (relative to the worktree, "" for its root). */
  onOpenTerminal?: (dir: string) => void;
  /** The file in front in the editor tabs, relative to the worktree; the tree follows it when asked to. */
  activeFile?: string | null;
  /** The disk events of the shown worktree; each batch is applied once. Held while a name dialog is open. */
  queue?: WatchQueue | null;
  /** How watching the disk goes; `limit` shows why live updates stopped. */
  watchHealth?: WatchHealth;
}): JSX.Element {
  const { api, worktree, changes, onOpen, onSearch, onOpenTerminal, activeFile = null, queue = null } = props;
  const { t } = useI18n();
  const [folders, setFolders] = useState<Record<string, Folder>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [filterOpen, setFilterOpen] = useState(false);
  // Every file of the worktree, read when the filter opens; null until it arrives.
  const [listed, setListed] = useState<string[] | null>(null);
  const [follow, setFollow] = useState(loadReveal);
  const [showIgnored, setShowIgnored] = useState(loadShowIgnored);
  // The row that flashes after a manual reveal, and the file whose row will flash once it is drawn.
  const [flash, setFlash] = useState<string | null>(null);
  const flashNext = useRef<string | null>(null);
  // The row being dragged, and the folder it is over ("" is the worktree root).
  const dragging = useRef<string | null>(null);
  const [dropOn, setDropOn] = useState<string | null>(null);
  // A move onto a name that is taken waits for a yes.
  const [replace, setReplace] = useState<{ rel: string; dest: string } | null>(null);
  // The row the arrow keys are on, and the options menu of the header.
  const [cursor, setCursor] = useState<string | null>(null);
  const [options, setOptions] = useState<{ x: number; y: number } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [menu, setMenu] = useState<{ x: number; y: number; target: Target | null } | null>(null);
  const [ask, setAsk] = useState<Ask | null>(null);
  // Bumped when the cache is dropped, so an answer to an older question is not kept.
  const epoch = useRef(0);
  // Folders asked for and not answered yet, so a second click does not ask again.
  const asked = useRef(new Set<string>());
  const openNow = useRef(open);
  openNow.current = open;
  const foldersNow = useRef(folders);
  foldersNow.current = folders;
  const flashTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const treeEl = useRef<HTMLDivElement | null>(null);
  // Set when a key moved the cursor, so the row takes the focus; and the file to scroll to once its row exists.
  const focusCursor = useRef(false);
  const scrollTo = useRef<string | null>(null);
  // A remote worktree has no folder listing: its folders come from the file list, asked once for
  // the folders read together.
  const fileList = useRef<Promise<FileList> | null>(null);
  // A changed file opens as a diff; a remote one has no diff yet, so it opens in the editor.
  const diffs = !isRemoteWorktree(worktree);

  function listDir(dir: string): Promise<DirListing> {
    if (!isRemoteWorktree(worktree)) return api.worktreeListDir(worktree, dir);
    if (!fileList.current) {
      const asking = api.filesList(worktree);
      fileList.current = asking;
      const done = () => {
        if (fileList.current === asking) fileList.current = null;
      };
      asking.then(done, done);
    }
    return fileList.current.then((list) => listingFromFiles(list, dir));
  }

  function read(dir: string): void {
    if (asked.current.has(dir)) return;
    asked.current.add(dir);
    const seq = epoch.current;
    const keep = (folder: Folder) => {
      if (seq !== epoch.current) return;
      asked.current.delete(dir);
      setFolders((all) => ({ ...all, [dir]: folder }));
    };
    listDir(dir).then(
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

  // The name filter searches every file, not only the folders opened so far.
  useEffect(() => {
    if (!filterOpen) return;
    let stale = false;
    api.filesList(worktree).then(
      (list) => !stale && setListed(list.files),
      () => !stale && setListed([]),
    );
    return () => {
      stale = true;
    };
  }, [api, worktree, changes, refresh, filterOpen]);

  // The file in front opens the folders above it and scrolls into view.
  useEffect(() => {
    if (!follow || !activeFile) return;
    const next = revealOpen(openNow.current, activeFile);
    if (next !== openNow.current) {
      setOpen(next);
      for (const dir of next) if (!folders[dir]) read(dir);
    }
    scrollTo.current = activeFile;
  }, [activeFile, follow, worktree]);

  // "Reveal in file tree" from an editor tab: open the folders above the file, scroll to it, flash its row.
  useEffect(
    () =>
      onTreeReveal((req) => {
        if (req.worktree !== worktree) return;
        const next = revealOpen(openNow.current, req.rel);
        if (next !== openNow.current) {
          setOpen(next);
          for (const dir of next) if (!foldersNow.current[dir]) read(dir);
        }
        setFilter("");
        setFilterOpen(false);
        setCursor(req.rel);
        scrollTo.current = req.rel;
        flashNext.current = req.rel;
        setRefresh((n) => n + 1);
      }),
    [worktree],
  );

  // Runs after every draw: the row to scroll to or to focus is looked up when it is there.
  useEffect(() => {
    const el = treeEl.current;
    if (!el) return;
    const rowOf = (path: string) => Array.from(el.querySelectorAll<HTMLElement>("[data-path]")).find((r) => r.dataset.path === path);
    if (scrollTo.current) {
      const row = rowOf(scrollTo.current);
      if (row) {
        row.scrollIntoView?.({ block: "nearest" });
        scrollTo.current = null;
        if (flashNext.current === row.dataset.path) {
          flashNext.current = null;
          setFlash(row.dataset.path ?? null);
          if (flashTimer.current) clearTimeout(flashTimer.current);
          flashTimer.current = setTimeout(() => setFlash(null), FLASH_MS);
        }
      }
    }
    if (focusCursor.current && cursor !== null) {
      focusCursor.current = false;
      rowOf(cursor)?.focus();
    }
  });

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
      const code = toApiError(e).code;
      const key = code === "no_web_remote" ? "gitHistory.noWebRemote" : code === "remote_unsupported" ? "remote.unsupported" : "files.openOnHostFailed";
      pushToast({ id: "files-open-host", text: t(key) });
    }
  }

  const menuItems = (target: Target | null): MenuItem[] =>
    treeMenuItems(target, {
      open: (rel) => openFile({ worktree, rel }),
      copyPath: (rel) => void copyAbsolute(io(), rel),
      copyRel: (rel) => void copyRelative(rel),
      findIn: (dir) => {
        findInFolder(dir);
        onSearch?.();
      },
      openTerminal: (dir) => onOpenTerminal?.(dir),
      ask: setAsk,
      reveal: (rel) =>
        void api.fileReveal(worktree, rel).catch((e) => {
          if (toApiError(e).code === "remote_unsupported") pushToast({ id: "files-reveal", text: t("remote.unsupported") });
        }),
      openOnHost: (rel) => void openOnHost(rel),
    });

  const onMenu = (e: MouseEvent, target: Target | null) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, target });
  };

  const all = treeRows(folders, open, changes, showIgnored);
  const found = filterOpen && filter.trim() !== "" ? matchFiles(listed ?? [], filter) : null;
  const rows = found ? [] : all;
  // The rows the keys walk: the matches while filtering, else every folder and file shown.
  const navRows: NavRow[] = found
    ? found.hits.map((h) => ({ path: h.rel, dir: false, open: false, depth: 0 }))
    : all.flatMap((r) => (r.type === "note" ? [] : [{ path: r.path, dir: r.type === "dir", open: r.type === "dir" && r.open, depth: r.depth }]));
  const here = navRows.some((r) => r.path === cursor) ? cursor : null;
  const tabbable = here ?? navRows[0]?.path ?? null;
  const kinds = new Map(changes.map((c) => [c.path, c.kind]));

  const closeFilter = () => {
    setFilter("");
    setFilterOpen(false);
  };

  function onKeyDown(e: ReactKeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.altKey && e.code === "KeyC") {
      if (here === null) return;
      e.preventDefault();
      void (e.shiftKey ? copyRelative(here) : copyAbsolute(io(), here));
      return;
    }
    // Cmd+Backspace is Delete on a Mac keyboard that has no Delete key.
    if (e.key === "Delete" || (e.metaKey && e.key === "Backspace")) {
      if (here === null) return;
      e.preventDefault();
      setAsk({ kind: "delete", rel: here });
      return;
    }
    if (mod || e.altKey || e.shiftKey || !NAV_KEYS.includes(e.key)) return;
    // Space and F2 are not the tree's while a text field (the filter) has the focus.
    if ((e.key === " " || e.key === "F2") && (e.target as HTMLElement).closest?.("input,textarea")) return;
    // The key is the tree's: a focused row would otherwise also click on Enter.
    e.preventDefault();
    const go = navigate(navRows, here, e.key as NavKey);
    if (!go) return;
    if (go.kind === "select") {
      focusCursor.current = true;
      setCursor(go.path);
    } else if (go.kind === "open") openFile({ worktree, rel: go.path });
    else if (go.kind === "preview") openFile({ worktree, rel: go.path, preview: true });
    else if (go.kind === "rename") setAsk({ kind: "rename", dir: parentOf(go.path), rel: go.path });
    else if (go.kind === "toggle" || (go.kind === "expand") === !open.includes(go.path)) toggle(go.path);
  }

  // A folder row, or the empty space of the tree (the worktree root), takes a dropped row.
  const dropOver = (dest: string) => ({
    "data-drop": dropOn === dest || undefined,
    onDragOver: (e: ReactDragEvent) => {
      const from = dragging.current;
      if (from === null || !canMove(from, dest)) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      if (dropOn !== dest) setDropOn(dest);
    },
    onDrop: (e: ReactDragEvent) => {
      const from = dragging.current;
      dragging.current = null;
      setDropOn(null);
      if (from === null || !canMove(from, dest)) return;
      e.preventDefault();
      e.stopPropagation();
      if (namesIn(dest).includes(fileName(from))) setReplace({ rel: from, dest });
      else void moveEntry(io(), from, dest).then((r) => (r === "exists" ? setReplace({ rel: from, dest }) : Array.isArray(r) ? r.forEach(reload) : undefined));
    },
  });

  const cell = (path: string) => ({
    "data-path": path,
    "aria-selected": here === path,
    "data-active": activeFile === path || undefined,
    "data-flash": flash === path || undefined,
    draggable: true,
    onDragStart: (e: ReactDragEvent) => {
      dragging.current = path;
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", path);
    },
    onDragEnd: () => {
      dragging.current = null;
      setDropOn(null);
    },
    tabIndex: tabbable === path ? 0 : -1,
    onFocus: () => setCursor(path),
  });
  return (
    <div className="ws-tree-wrap">
      <div className="ws-tree-tools">
        <button type="button" className="ws-tree-tool" data-action="filter" aria-pressed={filterOpen} title={t("files.tree.filterToggle")} aria-label={t("files.tree.filterToggle")} onClick={() => (filterOpen ? closeFilter() : setFilterOpen(true))}>
          <Icon name="magnifier" size={13} />
        </button>
        <button type="button" className="ws-tree-tool" data-action="refresh" title={t("files.tree.refresh")} aria-label={t("files.tree.refresh")} onClick={() => setRefresh((n) => n + 1)}>
          ↻
        </button>
        <button type="button" className="ws-tree-tool" data-action="collapse" title={t("files.tree.collapseAll")} aria-label={t("files.tree.collapseAll")} onClick={() => setOpen([])}>
          ⊟
        </button>
        <button
          type="button"
          className="ws-tree-tool"
          data-action="options"
          title={t("files.tree.options")}
          aria-label={t("files.tree.options")}
          aria-haspopup="menu"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setOptions({ x: box.left, y: box.bottom });
          }}
        >
          <Icon name="more" size={13} />
        </button>
        <button type="button" className="ws-tree-tool" data-action="search" disabled={!onSearch} onClick={onSearch}>
          {t("files.tree.searchInFiles")}
        </button>
      </div>
      {filterOpen && (
        <div className="ws-tree-tools">
          <input
            className="ws-tree-filter"
            type="search"
            data-field="filter"
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
            placeholder={t("files.tree.filterPlaceholder")}
            aria-label={t("files.tree.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              e.preventDefault();
              closeFilter();
            }}
          />
        </div>
      )}
      {props.watchHealth === "limit" && <Banner title={t("files.watch.limit.title")}>{t("files.watch.limit.body")}</Banner>}
    <div ref={treeEl} className="ws-tree" role="tree" aria-label={t("workspace.files.tree")} onKeyDown={onKeyDown} onContextMenu={(e) => onMenu(e as unknown as MouseEvent, null)} {...dropOver("")}>
      {found && found.hits.length === 0 && listed !== null && <div className="ws-tree-note">{t("files.tree.filterEmpty")}</div>}
      {found?.hits.map((hit) => (
        <button
          key={hit.rel}
          type="button"
          role="treeitem"
          className="ws-tree-row"
          aria-level={1}
          title={hit.rel}
          style={{ paddingLeft: "var(--tree-pad)" }}
          {...cell(hit.rel)}
          onClick={() => (diffs && kinds.has(hit.rel) ? onOpen(hit.rel) : openFile({ worktree, rel: hit.rel }))}
          onDoubleClick={() => openFile({ worktree, rel: hit.rel })}
          onContextMenu={(e) => onMenu(e as unknown as MouseEvent, { rel: hit.rel, dir: false })}
        >
          <Icon name="file" className="ws-tree-icon" size={13} />
          <span className="ws-tree-name">{hit.name}</span>
          {hit.dir !== "" && <span className="ws-tree-dir">{hit.dir}</span>}
        </button>
      ))}
      {found && found.more && <div className="ws-tree-note">{t("files.tree.filterMore", { n: found.hits.length })}</div>}
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
              data-ignored={row.ignored || undefined}
              {...cell(row.path)}
              {...dropOver(row.path)}
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
            data-ignored={row.ignored || undefined}
            {...cell(row.path)}
            onClick={() => (diffs && changed ? onOpen(row.path) : openFile({ worktree, rel: row.path }))}
            onDoubleClick={() => openFile({ worktree, rel: row.path })}
            onContextMenu={(e) => onMenu(e as unknown as MouseEvent, { rel: row.path, dir: false })}
          >
            {body}
          </button>
        );
      })}
    </div>
      {options && (
        <ContextMenu
          at={options}
          items={[
            {
              id: "revealActive",
              labelKey: "files.tree.revealActive",
              checked: follow,
              run: () => {
                saveReveal(!follow);
                setFollow(!follow);
              },
            },
            {
              id: "showIgnored",
              labelKey: "files.tree.showIgnored",
              checked: showIgnored,
              run: () => {
                saveShowIgnored(!showIgnored);
                setShowIgnored(!showIgnored);
              },
            },
          ]}
          onClose={() => setOptions(null)}
        />
      )}
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
      <ConfirmDialog
        open={replace !== null}
        titleId="move-title"
        title={t("files.move.title", { name: replace ? fileName(replace.rel) : "" })}
        body={t("files.move.body")}
        confirmLabel={t("files.move.confirm")}
        onCancel={() => setReplace(null)}
        onConfirm={() => {
          const r = replace;
          setReplace(null);
          if (r) void moveEntry(io(), r.rel, r.dest, true).then((res) => (Array.isArray(res) ? res.forEach(reload) : undefined));
        }}
      />
    </div>
  );
}
