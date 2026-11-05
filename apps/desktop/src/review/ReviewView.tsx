import { useEffect, useRef, useState } from "react";
import { Badge, Button, FilterChip, SearchInput, TreeView } from "@xdev-asia/ui";
import { reviewRows } from "./reviewRows";
import type { JSX } from "react";
import { toApiError, type Api, type ReviewData, type ReviewFile, type ReviewNote } from "@/api";
import type { Problem } from "@/changes/useChanges";
import { ProblemNote } from "@/components/ChangesPanel";
import { useI18n } from "@/i18n";
import { onChangesTouched, touchChanges } from "@/workspace/changesBus";
import type { Sessions } from "@/workspace/sessions";
import type { TabStatus } from "@/workspace/status";
import { BasePicker } from "./BasePicker";
import { FileDiff, type DiffHandle } from "./FileDiff";
import { nextChange, type ChangeAt } from "./navigate";
import { postBlock } from "./postable";
import { sortNotes } from "./notes";
import { noteLabel } from "./NoteCard";
import { SendNotesMenu } from "./SendNotesMenu";
import { AiStatus } from "./AiStatus";
import { readAuto, writeAuto } from "./aiReview";
import { useAiReview } from "./useAiReview";
import { useReviewNotes } from "./useReviewNotes";
import { AgentChips } from "./attribution/AgentChips";
import { LivePanel } from "./attribution/LivePanel";
import { VersionsDialog } from "./attribution/VersionsDialog";
import { agentCount, isMulti, multiPaths, touchersByPath } from "./attribution/attributionModel";
import { useAttribution } from "./attribution/useAttribution";
import type { DiffSettings } from "@/api";
import { DIFF_DEFAULTS } from "@/settings/generalDefaults";
import { clampListWidth, fromDiffSettings, migrateViewOptions, readLocalView, toDiffSettings, writeLocalView, type ViewOptions } from "./viewOptions";

// Past this many files the sections start closed, so opening the tab does not read them all.
export const OPEN_LIMIT = 30;
const STEP = 16;
const firstLine = (text: string) => text.split(/\r?\n/, 1)[0];

const storage = (): Storage | null => (typeof localStorage === "undefined" ? null : localStorage);
const LETTER: Record<ReviewFile["kind"], string> = { added: "A", modified: "M", deleted: "D" };

/**
 * Every change of one worktree against a base the person picks, as one scrolling list of files.
 * It reads again when the window gets focus, after staging, and when an agent of the worktree
 * goes quiet.
 */
export function ReviewView(props: {
  api: Api;
  worktree: string;
  sessions?: Sessions | null;
  reveal?: { file: string; seq: number };
  /** Posts a note to the PR as an inline comment. Left out, the view uses the worktree's own open PR. */
  onPostToPr?: (note: ReviewNote) => Promise<void>;
}): JSX.Element {
  const { api, worktree, sessions, reveal } = props;
  const { t } = useI18n();
  // Starts from the diff settings; what is changed here stays in this view until "Save as default".
  const [opts, setOpts] = useState<ViewOptions>(() => fromDiffSettings(DIFF_DEFAULTS, readLocalView(storage())));
  const [saved, setSaved] = useState<DiffSettings>(DIFF_DEFAULTS);
  const [data, setData] = useState<ReviewData | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [rev, setRev] = useState(0);
  const [busy, setBusy] = useState(false);
  const [target, setTarget] = useState<{ file: string; seq: number }>({ file: "", seq: 0 });
  const [seen, setSeen] = useState(0);
  const picked = useRef<string | null>(null);
  const loads = useRef(0);
  // This view's own listener on the changes bus, so it does not read twice after its own stage.
  const touched = useRef<(() => void) | undefined>(undefined);
  const running = useRef(0);
  const handles = useRef(new Map<string, DiffHandle>());
  // A jump into a file that is not drawn yet; it runs when that file registers.
  const pending = useRef<{ file: string; chunk?: number; line?: number } | null>(null);
  const cursor = useRef<ChangeAt | null>(null);
  const drag = useRef<{ x: number; width: number } | null>(null);
  const store = useReviewNotes(api, worktree);
  const ai = useAiReview(api, worktree);
  const [auto, setAuto] = useState(() => readAuto(storage()));
  const [openPr, setOpenPr] = useState<number | null>(null);
  // The PR head on GitHub, read again after every review read (a push does not move the local HEAD).
  const [prHead, setPrHead] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.worktreePr(worktree).then(
      (pr) => live && setOpenPr(pr && (pr.state === "open" || pr.state === "draft") ? pr.number : null),
      () => live && setOpenPr(null),
    );
    return () => {
      live = false;
    };
  }, [api, worktree]);
  useEffect(() => {
    if (openPr === null) {
      setPrHead(null);
      return;
    }
    let live = true;
    api.worktreePrHead(worktree, openPr).then(
      (head) => live && setPrHead(head),
      () => live && setPrHead(null),
    );
    return () => {
      live = false;
    };
  }, [api, worktree, openPr, rev]);
  const postToPr =
    props.onPostToPr ??
    (openPr === null
      ? undefined
      : (note: ReviewNote) =>
          api.worktreePrCommentPost(worktree, openPr, {
            body: note.body,
            replyTo: null,
            commit: data?.headOid ?? null,
            path: note.file,
            line: note.line,
            startLine: note.startLine === note.line ? null : note.startLine,
          }));
  const [listing, setListing] = useState(false);
  // Who changed each file; the filter keeps the files several agents touched.
  const attribution = useAttribution(api, worktree);
  const [multiOnly, setMultiOnly] = useState(false);
  const [live, setLive] = useState(false);
  const [versionsOf, setVersionsOf] = useState<string | null>(null);
  // Folder ids (`path/`) of the tree that are folded; local to this view.
  const [closed, setClosed] = useState<string[]>([]);
  // One array per file, kept while that file's notes are the same objects, so an untouched file is not redrawn.
  const perFile = useRef(new Map<string, ReviewNote[]>());
  const notesOf = (path: string): ReviewNote[] => {
    const next = [...store.notes.filter((n) => n.file === path), ...ai.notes.filter((n) => n.file === path)];
    const old = perFile.current.get(path);
    if (old && old.length === next.length && old.every((n, i) => n === next[i])) return old;
    perFile.current.set(path, next);
    return next;
  };

  // A reveal opens its file and scrolls to it; taken during render so the frame that asks already shows it.
  if (reveal && reveal.seq !== seen) {
    setSeen(reveal.seq);
    setExpanded({ ...expanded, [reveal.file]: true });
    setTarget(reveal);
  }

  async function load(): Promise<void> {
    const seq = ++loads.current;
    running.current = seq;
    try {
      const next = await api.worktreeReview(worktree, picked.current);
      if (seq !== loads.current) return;
      setData(next);
      setProblem(null);
      setRev((r) => r + 1);
    } catch (e) {
      if (seq === loads.current) setProblem(toApiError(e));
    } finally {
      if (running.current === seq) running.current = 0;
    }
  }

  // A failed base keeps what is shown and says why.
  async function pickBase(base: string | null): Promise<void> {
    const seq = ++loads.current;
    try {
      const next = await api.worktreeReview(worktree, base);
      if (seq !== loads.current) return;
      picked.current = base;
      cursor.current = null;
      setData(next);
      setProblem(null);
      setCounts({});
      setRev((r) => r + 1);
    } catch (e) {
      if (seq === loads.current) setProblem(toApiError(e));
    }
  }

  // The diff settings are where a view starts; a copy an older version kept in localStorage moves over once.
  useEffect(() => {
    let live = true;
    api
      .diffSettings()
      .then((stored) => migrateViewOptions(storage(), stored, (next) => api.diffSettingsPut(next)))
      .then((now) => {
        if (!live) return;
        setSaved(now);
        setOpts(fromDiffSettings(now, readLocalView(storage())));
      })
      .catch(() => {
        // The built-in defaults stay.
      });
    return () => {
      live = false;
    };
  }, [api]);

  useEffect(() => {
    void load();
    const again = () => {
      if (!running.current) void load();
    };
    window.addEventListener("focus", again);
    // The changes panel staged or discarded something.
    const onTouched = () => void load();
    touched.current = onTouched;
    const stop = onChangesTouched(worktree, onTouched);
    return () => {
      window.removeEventListener("focus", again);
      stop();
      loads.current++;
    };
  }, [api, worktree]);

  // An agent that went quiet has likely written files.
  useEffect(() => {
    if (!sessions) return;
    const statuses = () => new Map<string, TabStatus>(sessions.tabs(worktree).map((tab) => [tab.id, tab.status]));
    let before = statuses();
    return sessions.subscribe(() => {
      const now = statuses();
      if ([...now].some(([id, status]) => status === "idle" && before.get(id) === "working")) void load();
      before = now;
    });
  }, [api, worktree, sessions]);

  // Review automatically: once when the screen has a diff it has not reviewed yet; `run` skips a hash it knows.
  const baseId = data?.base.id;
  const changed = (data?.files.length ?? 0) > 0;
  useEffect(() => {
    if (auto && baseId && changed) void ai.run(baseId, { auto: true });
  }, [auto, baseId, changed, worktree]);

  const files = data?.files ?? [];
  const needle = filter.trim().toLowerCase();
  const byPath = touchersByPath(attribution.files);
  const multiCount = multiPaths(files.map((f) => f.path), byPath).length;
  const matching = needle ? files.filter((f) => f.path.toLowerCase().includes(needle)) : files;
  const shown = multiOnly ? matching.filter((f) => isMulti(byPath.get(f.path))) : matching;
  // The clicked file stays marked only while it is still in the review.
  const active = selected !== null && files.some((f) => f.path === selected) ? selected : undefined;
  const isOpen = (path: string) => expanded[path] ?? files.length <= OPEN_LIMIT;

  function setOption(patch: Partial<ViewOptions>): void {
    const next = { ...opts, ...patch };
    setOpts(next);
    if ("lineNumbers" in patch || "listWidth" in patch) writeLocalView(storage(), next);
  }

  const unsaved = JSON.stringify(toDiffSettings(opts, saved)) !== JSON.stringify(saved);
  async function saveDefault(): Promise<void> {
    try {
      setSaved(await api.diffSettingsPut(toDiffSettings(opts, saved)));
    } catch (e) {
      setProblem(toApiError(e));
    }
  }

  function toggle(path: string): void {
    setExpanded({ ...expanded, [path]: !isOpen(path) });
  }

  function show(path: string): void {
    setSelected(path);
    setExpanded({ ...expanded, [path]: true });
    setTarget({ file: path, seq: target.seq + 1 });
  }

  async function stage(file: ReviewFile, staging: boolean): Promise<void> {
    setBusy(true);
    try {
      await api.worktreeStage(worktree, [file.path], staging);
      touchChanges(worktree, touched.current);
      await load();
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
    }
  }

  // A note in the Notes list: open its file and bring the lines into view once the diff is drawn.
  function jumpToNote(note: ReviewNote): void {
    setListing(false);
    show(note.file);
    const handle = handles.current.get(note.file);
    if (handle) handle.goToLine(note.line);
    else pending.current = { file: note.file, line: note.line };
  }

  function go(dir: 1 | -1): void {
    // A file never opened has no count yet, but every listed file has changes.
    const list = files.map((f) => ({ path: f.path, chunks: counts[f.path] ?? 1 }));
    const at = nextChange(list, cursor.current, dir);
    if (!at) return;
    cursor.current = at;
    const path = files[at.file].path;
    const handle = handles.current.get(path);
    if (handle) return void handle.goTo(at.chunk);
    // A closed file (or one still being read) is opened; the jump runs when its diff registers.
    setExpanded({ ...expanded, [path]: true });
    pending.current = { file: path, chunk: at.chunk };
  }

  function key(e: { key: string; shiftKey: boolean; preventDefault(): void }): void {
    if (e.key !== "F7") return;
    e.preventDefault();
    go(e.shiftKey ? -1 : 1);
  }

  const width = clampListWidth(opts.listWidth);
  const flag = (name: "ignoreWhitespace" | "collapse" | "lineNumbers" | "wrap", label: string) => (
    <label className="rv-check">
      <input type="checkbox" checked={opts[name]} onChange={() => setOption({ [name]: !opts[name] })} />
      <span>{t(label)}</span>
    </label>
  );

  return (
    <div className="rv" onKeyDown={key}>
      <div className="rv-bar">
        {data && <BasePicker api={api} worktree={worktree} base={data.base} baseRef={data.baseRef} onPick={(b) => void pickBase(b)} />}
        <div className="rv-layout" role="group" aria-label={t("review.layout")}>
          {(["inline", "split"] as const).map((layout) => (
            <button key={layout} type="button" aria-pressed={opts.layout === layout} onClick={() => setOption({ layout })}>
              {t(`review.layout.${layout}`)}
            </button>
          ))}
        </div>
        {flag("ignoreWhitespace", "review.opt.whitespace")}
        {flag("collapse", "review.opt.collapse")}
        {flag("lineNumbers", "review.opt.lineNumbers")}
        {flag("wrap", "review.opt.wrap")}
        <div className="rv-layout" role="group" aria-label={t("review.view")}>
          {([false, true] as const).map((tree) => (
            <button key={String(tree)} type="button" data-view={tree ? "tree" : "list"} aria-pressed={opts.tree === tree} onClick={() => setOption({ tree })}>
              {t(tree ? "review.view.tree" : "review.view.list")}
            </button>
          ))}
        </div>
        <button type="button" className="rv-base-button" data-act="save-default" disabled={!unsaved} onClick={() => void saveDefault()}>
          {t("review.opt.saveDefault")}
        </button>
        <div className="rv-notes">
          <button type="button" className="rv-base-button" aria-haspopup="dialog" aria-expanded={listing} onClick={() => setListing(!listing)}>
            {t("review.notes", { count: store.notes.length })}
          </button>
          {listing && (
            <div className="rv-base-menu rv-notes-menu" role="dialog" aria-label={t("review.notes.title")}>
              {store.notes.length === 0 && <p className="ws-empty">{t("review.notes.none")}</p>}
              {sortNotes(store.notes).map((n) => (
                <button key={n.id} type="button" onClick={() => jumpToNote(n)}>
                  <span className="rv-note-label ws-mono">{noteLabel(n)}</span>
                  {n.sentAt !== null && <span className="rv-mark rv-mark-sent">{t("review.note.sent")}</span>}
                  {n.outdated && <span className="rv-mark rv-mark-outdated">{t("review.note.outdated")}</span>}
                  <span className="rv-note-snippet">{firstLine(n.body)}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" className="rv-base-button" data-act="live" aria-expanded={live} onClick={() => setLive(!live)}>
          {t("review.attr.live")}
        </button>
        <button type="button" className="rv-base-button" data-act="ai-review" disabled={ai.busy || !data || files.length === 0} onClick={() => data && void ai.run(data.base.id)}>
          {t("review.ai.run")}
        </button>
        <label className="rv-check">
          <input
            type="checkbox"
            checked={auto}
            onChange={() => {
              writeAuto(storage(), !auto);
              setAuto(!auto);
            }}
          />
          <span>{t("review.ai.auto")}</span>
        </label>
        <SendNotesMenu sessions={sessions} worktree={worktree} branch={data?.branch ?? null} notes={store.notes} markSent={store.markSent} />
        {store.removed && (
          <span className="rv-undo" role="status">
            {t("review.note.deleted")}
            <button type="button" onClick={() => void store.undo()}>
              {t("review.note.undo")}
            </button>
          </span>
        )}
        <span className="rv-count">{t("review.files", { count: files.length })}</span>
      </div>
      <AiStatus state={ai} onCancel={ai.cancel} />
      {live && <LivePanel events={attribution.recent} onOpen={show} />}
      {problem && <ProblemNote problem={problem} />}
      {store.problem && <ProblemNote problem={store.problem} />}
      {data && files.length === 0 && <p className="ws-empty">{t("review.empty")}</p>}
      {files.length > 0 && data && (
        <div className="rv-main">
          <nav className="rv-list" style={{ width }} aria-label={t("review.list")}>
            <SearchInput
              size="sm"
              className="rv-filter"
              value={filter}
              placeholder={t("review.filter")}
              aria-label={t("review.filter")}
              labels={{ clear: t("review.filter.clear") }}
              onChange={(e) => setFilter(e.target.value)}
              onClear={() => setFilter("")}
            />
            {multiCount > 0 && (
              <div className="task-chips attr-filter">
                <FilterChip pressed={multiOnly} count={multiCount} onClick={() => setMultiOnly(!multiOnly)}>
                  {t("review.attr.filter")}
                </FilterChip>
              </div>
            )}
            {shown.length === 0 && <p className="ws-empty">{t("review.filter.none")}</p>}
            {opts.tree ? (
              <TreeView
                rows={reviewRows(shown, new Set(closed))}
                selected={active}
                labels={{ tree: t("review.tree"), changed: t("review.tree.changed"), marks: { added: t("review.kind.added"), modified: t("review.kind.modified"), deleted: t("review.kind.deleted") } }}
                onToggle={(id) => setClosed(closed.includes(id) ? closed.filter((c) => c !== id) : [...closed, id])}
                onOpen={show}
              />
            ) : (
              <>
              {shown.map((f) => (
                <button key={f.path} type="button" className="rv-list-item" data-path={f.path} aria-current={f.path === active ? "true" : undefined} title={f.path} onClick={() => show(f.path)}>
                  <span className="rv-letter ws-mono" data-kind={f.kind} aria-hidden="true">
                    {LETTER[f.kind]}
                  </span>
                  <span className="rv-list-path ws-mono">{f.path}</span>
                  <AgentChips touchers={byPath.get(f.path) ?? []} compact />
                  {f.staged && <span className="rv-dot" data-partial={f.unstaged} title={t("review.staged")} />}
                </button>
              ))}
              </>
            )}
          </nav>
          <div
            className="rv-resize"
            role="separator"
            aria-orientation="vertical"
            aria-label={t("review.resize")}
            aria-valuemin={160}
            aria-valuemax={480}
            aria-valuenow={width}
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              setOption({ listWidth: clampListWidth(width + (e.key === "ArrowRight" ? STEP : -STEP)) });
            }}
            onPointerDown={(e) => {
              drag.current = { x: e.clientX, width };
              e.currentTarget.setPointerCapture?.(e.pointerId);
            }}
            onPointerMove={(e) => {
              if (drag.current) setOption({ listWidth: clampListWidth(drag.current.width + e.clientX - drag.current.x) });
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
          />
          <div className="rv-files">
            {files.map((f) => (
              <FileDiff
                key={f.path}
                extra={
                  <span className="attr-head">
                    <AgentChips touchers={byPath.get(f.path) ?? []} />
                    {isMulti(byPath.get(f.path)) && <Badge status="changed">{t("review.attr.multi", { count: agentCount(byPath.get(f.path)) })}</Badge>}
                    <Button variant="secondary" className="attr-versions-button" onClick={() => setVersionsOf(f.path)}>
                      {t("review.attr.versions")}
                    </Button>
                  </span>
                }
                api={api}
                worktree={worktree}
                base={data.base.id}
                file={f}
                opts={opts}
                open={isOpen(f.path)}
                rev={rev}
                revealSeq={target.file === f.path ? target.seq : 0}
                busy={busy}
                onToggle={toggle}
                onStage={(file, staging) => void stage(file, staging)}
                register={(path, handle) => {
                  if (!handle) return void handles.current.delete(path);
                  handles.current.set(path, handle);
                  const job = pending.current;
                  if (job?.file === path) {
                    pending.current = null;
                    if (job.line !== undefined) handle.goToLine(job.line);
                    else handle.goTo(job.chunk ?? 0);
                  }
                }}
                notes={notesOf(f.path)}
                handlers={{
                  add: (range, body) => void store.add(f.path, range.startLine, range.line, range.anchor, body),
                  edit: (id, body) => void store.edit(id, body),
                  remove: (id) => void store.remove(id),
                  dismissAi: (id) => void ai.dismiss(id),
                  convertAi: (id, range) => {
                    const found = ai.dismiss(id);
                    if (found) void store.add(f.path, range.startLine, range.line, range.anchor, found.body);
                  },
                  post: postToPr,
                  postBlock: props.onPostToPr ? undefined : (note) => postBlock(note, data, prHead),
                }}
                onRead={(path, text) => void store.reanchorFile(path, text)}
                onChunks={(path, count) => setCounts((c) => (c[path] === count ? c : { ...c, [path]: count }))}
              />
            ))}
          </div>
        </div>
      )}
      {versionsOf !== null && (
        <VersionsDialog
          api={api}
          worktree={worktree}
          path={versionsOf}
          onClose={() => setVersionsOf(null)}
          onRestored={() => {
            touchChanges(worktree, touched.current);
            void load();
          }}
        />
      )}
    </div>
  );
}
