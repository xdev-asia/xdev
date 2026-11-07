import { Button } from "@xdev-asia/ui";
import { useEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Home, type MemorySet } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { DiffView } from "@/components/DiffView";
import { Editor } from "@/components/Editor";
import { useI18n } from "@/i18n";
import { KitError, kitErr, type KitErr } from "./KitError";
import { below, displayPath, homeLabel, joinPath } from "./kitUi";

type MemoryFile = MemorySet["files"][number];

const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** An import outside every root: the scan lists it with no hash and never reads it, and neither does this view. */
const unread = (file: MemoryFile) => file.hash === "";

/** The editor holds `\n` lines; a file keeps the line ends it had on disk. */
const lf = (text: string) => text.replace(/\r\n/g, "\n");
const withEol = (text: string, eol: string) => (eol === "\n" ? text : text.replace(/\n/g, eol));

/** How deep a file sits under the file that imports it. */
function depthOf(file: MemoryFile, byPath: Map<string, MemoryFile>): number {
  let depth = 0;
  let at: MemoryFile | undefined = file;
  const seen = new Set<string>();
  while (at && at.parent !== null && !seen.has(at.path)) {
    seen.add(at.path);
    at = byPath.get(at.parent);
    if (at) depth += 1;
  }
  return depth;
}

/** The memory files grouped by home, then those of the worktree, with what each costs to load. */
export function MemoryTree(props: {
  set: MemorySet;
  homes: Home[];
  selected: string | null;
  onSelect(path: string): void;
}): JSX.Element {
  const { t } = useI18n();
  const { set, homes, selected } = props;
  const byPath = new Map(set.files.map((f) => [f.path, f]));
  const groups: Array<{ key: string; title: string; root: string | null; files: MemoryFile[] }> = [];
  for (const home of homes) {
    const files = set.files.filter((f) => f.home_id === home.id);
    if (files.length > 0) groups.push({ key: home.id, title: homeLabel(homes, home.id, t), root: home.path, files });
  }
  const loose = set.files.filter((f) => f.home_id === null || !homes.some((h) => h.id === f.home_id));
  if (loose.length > 0) groups.push({ key: "worktree", title: t("kit.memory.group.worktree"), root: null, files: loose });

  return (
    <nav className="kit-tree" aria-label={t("kit.memory.tree")}>
      <p className="kit-load">{t("kit.memory.load", { count: set.load_tokens })}</p>
      {set.files.length === 0 && <p className="kit-empty">{t("kit.memory.empty")}</p>}
      {groups.map((group) => (
        <section key={group.key} className="kit-group" data-group={group.key}>
          <h3 className="kit-h">{group.title}</h3>
          <ul className="kit-files">
            {group.files.map((file) => {
              const shown = (group.root !== null ? below(group.root, file.path) : null) ?? baseName(file.path);
              const row = {
                className: "kit-file",
                "data-file": file.path,
                "data-kind": file.kind,
                style: { paddingInlineStart: `${8 + depthOf(file, byPath) * 14}px` },
                title: displayPath(file.path),
              };
              return (
                <li key={file.path}>
                  {unread(file) ? (
                    <div {...row} data-unread="true">
                      <span className="kit-cut">{shown}</span>
                      <span className="kit-num">{t("kit.memory.outside")}</span>
                    </div>
                  ) : (
                    <button
                      type="button"
                      {...row}
                      aria-current={selected === file.path ? "true" : undefined}
                      onClick={() => props.onSelect(file.path)}
                    >
                      {file.issues.length > 0 && <span className="kit-dot" data-dot="issue" />}
                      <span className="kit-cut">{shown}</span>
                      <span className="kit-num">{t("kit.tokens", { count: file.tokens })}</span>
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </nav>
  );
}

interface Plan {
  target: string;
  label: string;
  /** What the target holds now; `null` when there is no file yet. */
  base: string | null;
  stamp: string | null;
  same: boolean;
}

interface Open {
  path: string;
  text: string;
  saved: string;
  stamp: string;
  /** The file's line end on disk, put back on every write. */
  eol: string;
}

export function MemoryTab(props: {
  api: Api;
  worktree: string | null;
  onOpenContext?: () => void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, worktree } = props;
  const [set, setSet] = useState<MemorySet>();
  const [homes, setHomes] = useState<Home[]>([]);
  const [error, setError] = useState<KitErr>();
  const [open, setOpen] = useState<Open | null>(null);
  const [changed, setChanged] = useState(false);
  const [keeping, setKeeping] = useState(false);
  // A file picked while the editor holds unsaved text; it opens once the person agrees.
  const [discarding, setDiscarding] = useState<string | null>(null);
  const [note, setNote] = useState<string>();
  const [plan, setPlan] = useState<Plan[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [reloads, setReloads] = useState(0);
  // The latest text for Ctrl+S, which the editor reads through a ref.
  const latest = useRef<Open | null>(null);
  latest.current = open;
  // A save in flight and the newest read, so a second Ctrl+S or a slow read cannot overtake the first.
  const saving = useRef(false);
  const reading = useRef(0);

  useEffect(() => {
    let stale = false;
    void (async () => {
      try {
        const [files, h] = await Promise.all([api.kitMemory(worktree), api.kitHomes()]);
        if (stale) return;
        setSet(files);
        setHomes(h);
      } catch (e) {
        if (!stale) setError(kitErr(e));
      }
    })();
    return () => {
      stale = true;
    };
  }, [api, worktree, reloads]);

  const dirty = open !== null && open.text !== open.saved;
  const file = open ? set?.files.find((f) => f.path === open.path) : undefined;

  async function select(path: string): Promise<void> {
    setError(undefined);
    setNote(undefined);
    setChanged(false);
    setPlan(null);
    const mine = ++reading.current;
    try {
      const read = await api.kitRead(path, worktree);
      const eol = read.text.includes("\r\n") ? "\r\n" : "\n";
      const text = lf(read.text);
      if (mine === reading.current) setOpen({ path, text, saved: text, stamp: read.stamp, eol });
    } catch (e) {
      if (mine === reading.current) setError(kitErr(e));
    }
  }

  /** A pick in the tree: unsaved text in the editor is not dropped until the person says so. */
  function pick(path: string): void {
    const picked = set?.files.find((f) => f.path === path);
    if (picked && unread(picked)) return;
    const current = latest.current;
    if (current && current.path !== path && current.text !== current.saved) setDiscarding(path);
    else void select(path);
  }

  async function save(): Promise<void> {
    const current = latest.current;
    if (!current || current.text === current.saved || saving.current) return;
    saving.current = true;
    setError(undefined);
    setNote(undefined);
    try {
      const stamp = await api.kitWrite(current.path, withEol(current.text, current.eol), current.stamp, worktree);
      setOpen((o) => (o && o.path === current.path ? { ...o, saved: current.text, stamp } : o));
      setChanged(false);
      setNote(t("kit.memory.saved"));
      setReloads((n) => n + 1);
    } catch (e) {
      if (toApiError(e).code === "changed") setChanged(true);
      else setError(kitErr(e));
    } finally {
      saving.current = false;
    }
  }

  async function reloadFile(): Promise<void> {
    if (!open) return;
    await select(open.path);
  }

  /** Keep mine: read again for a fresh stamp, then write the text that is on screen. */
  async function keepMine(): Promise<void> {
    setKeeping(false);
    const current = latest.current;
    if (!current || saving.current) return;
    saving.current = true;
    try {
      const fresh = await api.kitRead(current.path, worktree);
      const stamp = await api.kitWrite(current.path, withEol(current.text, current.eol), fresh.stamp, worktree);
      setOpen({ ...current, saved: current.text, stamp });
      setChanged(false);
      setNote(t("kit.memory.saved"));
      setReloads((n) => n + 1);
    } catch (e) {
      if (toApiError(e).code === "changed") setChanged(true);
      else setError(kitErr(e));
    } finally {
      saving.current = false;
    }
  }

  /** The other homes of the same agent, with the path this file would have in each. */
  const targets = useMemo(() => {
    if (!open || !file || file.home_id === null) return [];
    const source = homes.find((h) => h.id === file.home_id);
    const rel = source ? below(source.path, file.path) : null;
    if (!source || rel === null) return [];
    return homes
      .filter((h) => h.id !== source.id && h.agent === source.agent)
      .map((h) => ({ path: joinPath(h.path, rel), label: homeLabel(homes, h.id, t) }));
  }, [open, file, homes, t]);

  async function startCopy(): Promise<void> {
    if (!open) return;
    setError(undefined);
    setNote(undefined);
    try {
      const rows: Plan[] = [];
      for (const target of targets) {
        try {
          const read = await api.kitRead(target.path, worktree);
          rows.push({ target: target.path, label: target.label, base: lf(read.text), stamp: read.stamp, same: lf(read.text) === open.text });
        } catch (e) {
          // A file that is not there is an I/O failure in Rust (`io`); `not_found` is the same thing by another name.
          const code = toApiError(e).code;
          if (code !== "io" && code !== "not_found") throw e;
          rows.push({ target: target.path, label: target.label, base: null, stamp: null, same: false });
        }
      }
      setPlan(rows);
    } catch (e) {
      setError(kitErr(e));
    }
  }

  async function confirmCopy(): Promise<void> {
    if (!open || !plan) return;
    const todo = plan.filter((p) => !p.same);
    setBusy(true);
    try {
      for (const row of todo) await api.kitWrite(row.target, withEol(open.text, open.eol), row.stamp, worktree);
      setNote(t("kit.memory.copyDone", { count: todo.length }));
      setPlan(null);
      setReloads((n) => n + 1);
    } catch (e) {
      setError(kitErr(e, true));
      setPlan(null);
    } finally {
      setBusy(false);
    }
  }

  const copyOff = dirty ? t("kit.memory.copySave") : targets.length === 0 ? t("kit.memory.copyNone") : undefined;
  const pending = plan?.filter((p) => !p.same).length ?? 0;

  return (
    <div className="kit-memory">
      <aside className="kit-side">
        {set ? (
          <MemoryTree set={set} homes={homes} selected={open?.path ?? null} onSelect={pick} />
        ) : (
          !error && <p className="kit-empty">{t("kit.loading")}</p>
        )}
        {props.onOpenContext && (
          <button type="button" className="kit-link" data-action="open-context" onClick={props.onOpenContext}>
            {t("kit.memory.context")}
          </button>
        )}
      </aside>

      <div className="kit-main">
        {error && <KitError error={error} />}
        {!open ? (
          <p className="kit-empty">{t("kit.memory.pick")}</p>
        ) : (
          <>
            <div className="kit-bar-row">
              <span className="kit-cut kit-path" title={displayPath(open.path)}>{displayPath(open.path)}</span>
              {dirty && <span className="kit-chip">{t("kit.memory.dirty")}</span>}
              <span className="kit-spacer" />
              <Button variant="primary" type="button" disabled={!dirty} onClick={() => void save()}>{t("kit.memory.save")}</Button>
              <button
                type="button"
                className="btn-secondary"
                data-action="copy-other"
                disabled={copyOff !== undefined}
                title={copyOff}
                onClick={() => void startCopy()}
              >
                {t("kit.memory.copyOther")}
              </button>
            </div>

            {changed && (
              <div className="banner banner-warn" role="alert" data-bar="changed">
                <span>{t("kit.memory.changed")}</span>
                <button type="button" className="kit-link" data-action="reload" onClick={() => void reloadFile()}>{t("kit.memory.reload")}</button>
                <button type="button" className="kit-link" data-action="keep" onClick={() => setKeeping(true)}>{t("kit.memory.keep")}</button>
              </div>
            )}
            {note && <p className="kit-note" role="status">{note}</p>}

            <div className="kit-editor">
              <Editor
                key={open.path}
                value={open.text}
                onChange={(text) => setOpen((o) => (o ? { ...o, text } : o))}
                onSave={() => void save()}
              />
            </div>

            {file && file.issues.length > 0 && (
              <section className="kit-block" aria-label={t("kit.memory.issues")}>
                <h3 className="kit-h">{t("kit.memory.issues")}</h3>
                <ul className="kit-issues">
                  {file.issues.map((issue, i) => (
                    <li key={`${issue.line}-${i}`} data-issue={issue.kind}>
                      <span className="kit-dot" data-dot="issue" />
                      <span className="kit-num">{t("kit.memory.line", { line: issue.line })}</span>
                      <span>{t(`kit.memory.issue.${issue.kind}`, { target: issue.target })}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {plan && (
              <section className="kit-panel" aria-label={t("kit.memory.copyHeading")}>
                <h3 className="kit-h">{t("kit.memory.copyHeading")}</h3>
                {plan.map((row) => (
                  <div key={row.target} className="kit-plan" data-target={row.target}>
                    <p className="kit-cut" title={displayPath(row.target)}>{`${row.label} — ${displayPath(row.target)}`}</p>
                    {row.same ? (
                      <p className="kit-empty">{t("kit.memory.copySame")}</p>
                    ) : (
                      <>
                        {row.base === null && <p className="kit-note">{t("kit.memory.copyNew")}</p>}
                        <DiffView base={row.base ?? ""} current={open.text} />
                      </>
                    )}
                  </div>
                ))}
                {pending === 0 && <p className="kit-empty">{t("kit.memory.copyNothing")}</p>}
                <div className="kit-bar-row">
                  {pending > 0 && (
                    <Button variant="primary" type="button" disabled={busy} onClick={() => void confirmCopy()}>
                      {t("kit.memory.copyGo", { count: pending })}
                    </Button>
                  )}
                  <button type="button" className="btn-secondary" onClick={() => setPlan(null)}>{t("dialog.cancel")}</button>
                </div>
              </section>
            )}
          </>
        )}
      </div>

      <ConfirmDialog
        open={discarding !== null}
        title={t("kit.memory.discardTitle")}
        body={t("kit.memory.discardBody")}
        confirmLabel={t("kit.memory.discardConfirm")}
        onConfirm={() => {
          const next = discarding;
          setDiscarding(null);
          if (next !== null) void select(next);
        }}
        onCancel={() => setDiscarding(null)}
      />
      <ConfirmDialog
        open={keeping}
        title={t("kit.memory.keepTitle")}
        body={t("kit.memory.keepBody")}
        confirmLabel={t("kit.memory.keepConfirm")}
        onConfirm={() => void keepMine()}
        onCancel={() => setKeeping(false)}
      />
    </div>
  );
}
