import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev/ui";
import { createMockApi, type Api, type WorktreeChange, type WorktreeView } from "@/api";
import { DiffView } from "@/components/DiffView";
import { FileDiff } from "@/review/FileDiff";
import { ReviewView } from "@/review/ReviewView";
import { DEFAULT_VIEW } from "@/review/viewOptions";
import { translate } from "@/i18n";
import { touchChanges, onChangesTouched } from "./changesBus";
import { Sessions } from "./sessions";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WorktreeChanges } from "./WorktreeChanges";
import { WorktreeTabs } from "./WorktreeTabs";

// Hooks are stubbed only while a component under test is called; each harness keeps its own.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  const state = (initial: unknown) => {
    const { index, values } = slot(initial);
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    // The profile store is outside what these tests render; its context keeps the default.
    useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// xterm needs a real canvas; the terminals are tested on their own.
vi.mock("@/terminal/Terminal", () => ({ Terminal: () => null }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const START = "5555555555555555555555555555555555555555";
// One file section of the review, drawn open against the worktree's start.
const section = (api: Api, path: string) =>
  FileDiff({
    api,
    worktree: OAK,
    base: START,
    file: { path, kind: "modified", staged: false, unstaged: true },
    opts: DEFAULT_VIEW,
    open: true,
    rev: 0,
    revealSeq: 0,
    busy: false,
    onToggle() {},
    onStage() {},
    register() {},
    onChunks() {},
    notes: [],
    handlers: { add() {}, edit() {}, remove() {} },
    onRead() {},
  });
const oak: WorktreeView = { path: OAK, name: "oak", branch: "oak", head: START, start: START, primary: false, pinned: false, detached: false };

// Calls `render` with its own hook values; the first draw's effects run once, as on mount.
function mount(render: () => unknown) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return render(); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  const cleanups = hooks.effects.slice(before).map((effect) => effect());
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const find = (pick: (n: Node) => boolean) => all().find(pick);
  return { draw, all, html, find, cleanups };
}

function changes(api: Api, sessions?: Sessions, extra: Partial<Parameters<typeof WorktreeChanges>[0]> = {}) {
  const onOpenFile = vi.fn();
  const onCount = vi.fn();
  const view = mount(() => WorktreeChanges({ api, worktree: oak, sessions, onOpenFile, onCount, ...extra }));
  const rows = () => view.all().filter((n) => n.type === "li");
  const row = (path: string) => rows().find((r) => nodes(r).some((n) => n.props.children === path))!;
  const box = (path: string) => nodes(row(path)).find((n) => n.type === "input")!;
  const commit = () => view.find((n) => n.type === Button)!;
  const message = () => view.find((n) => n.type === "textarea")!;
  return { ...view, onOpenFile, onCount, rows, row, box, commit, message };
}

let sessions: Sessions | null = null;
beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { sessions?.dispose(); sessions = null; vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("lists changes with kind letters and all checked", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeFileDiff");
  const view = changes(api);
  await tick();
  const html = view.html();
  for (const path of ["docs/old-notes.md", "src/session.ts", "src/status.ts"]) expect(html).toContain(path);
  const letter = (path: string) => nodes(view.row(path)).find((n) => n.props["data-kind"])!.props.children;
  expect([letter("docs/old-notes.md"), letter("src/session.ts"), letter("src/status.ts")]).toEqual(["D", "M", "A"]);
  expect(view.rows().map((r) => nodes(r).find((n) => n.type === "input")!.props.checked)).toEqual([true, true, true]);
  // A refresh reads no file; line counts wait until a file's diff is opened.
  expect(read).not.toHaveBeenCalled();
  expect(renderToStaticMarkup(view.row("src/session.ts"))).not.toContain("−");
  expect(html).toContain(en("workspace.changes.title", { count: 3 }));
  expect(view.commit().props.children).toBe(en("workspace.changes.commit", { count: 3 }));
  // Nothing to say yet.
  expect(view.commit().props.disabled).toBe(true);
  expect(view.onCount).toHaveBeenLastCalledWith(3);
});

it("shows line counts for a file once its diff loads, until the next refresh", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeFileDiff");
  const view = changes(api);
  await tick();
  const open = (path: string) => nodes(view.row(path)).find((n) => n.type === "button")!.props.onClick();
  open("src/session.ts");
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith(OAK, "src/session.ts");
  const modified = renderToStaticMarkup(view.row("src/session.ts"));
  expect(modified).toContain("+1");
  expect(modified).toContain("−1");
  expect(renderToStaticMarkup(view.row("src/status.ts"))).not.toContain("−");

  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(renderToStaticMarkup(view.row("src/session.ts"))).not.toContain("−");
  expect(read).toHaveBeenCalledTimes(1);
});

it("says line and lines in the stats text", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeFileDiff");
  const view = changes(api);
  await tick();
  nodes(view.row("src/session.ts")).find((n) => n.type === "button")!.props.onClick();
  await tick();
  expect(renderToStaticMarkup(view.row("src/session.ts"))).toContain("1 line added, 1 removed");
  read.mockResolvedValueOnce({ old: "a\n", new: "b\nc\n", skip: null });
  nodes(view.row("src/status.ts")).find((n) => n.type === "button")!.props.onClick();
  await tick();
  expect(renderToStaticMarkup(view.row("src/status.ts"))).toContain("2 lines added, 1 removed");
  // The diff header says the same.
  const diff = mount(() => section(api, "src/session.ts"));
  await tick();
  expect(diff.html()).toContain("1 line added, 1 removed");
});

it("does not start a second load on focus while one runs", async () => {
  const api = createMockApi({});
  let finish: (list: WorktreeChange[]) => void = () => {};
  const list = vi.spyOn(api, "worktreeChanges").mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
  changes(api);
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(list).toHaveBeenCalledTimes(1);
  finish([]);
  await tick();
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(list).toHaveBeenCalledTimes(2);
});

it("clears a load error once a later load works", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeChanges").mockRejectedValueOnce({ code: "git", detail: "index.lock exists" });
  const view = changes(api);
  await tick();
  expect(view.html()).toContain("index.lock exists");
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(view.html()).not.toContain("index.lock exists");
  expect(view.rows()).toHaveLength(3);
});

it("cannot commit with no file checked", async () => {
  const api = createMockApi({});
  const view = changes(api);
  await tick();
  view.message().props.onChange({ target: { value: "feat: status line" } });
  expect(view.commit().props.disabled).toBe(false);
  for (const path of ["docs/old-notes.md", "src/session.ts", "src/status.ts"]) view.box(path).props.onChange();
  expect(view.commit().props.disabled).toBe(true);
});

it("opens a diff tab for a file", async () => {
  const api = createMockApi({});
  const view = changes(api);
  await tick();
  nodes(view.row("src/session.ts")).find((n) => n.type === "button")!.props.onClick();
  expect(view.onOpenFile).toHaveBeenCalledWith("src/session.ts");

  // The center opens it as a tab next to the terminals.
  const live = (sessions = new Sessions(api));
  const term = live.open(OAK, "shell");
  const tabs = mount(() => WorktreeTabs({ api, sessions: live, worktree: OAK, visible: true, reveal: { file: "src/session.ts", seq: 1 } }));
  const tab = tabs.find((n) => n.props.role === "tab" && n.props["data-tab"] === "review:")!;
  expect(tab.props["aria-selected"]).toBe(true);
  const pane = (id: string) => tabs.find((n) => n.props.role === "tabpanel" && n.props["data-tab"] === id)!;
  expect(pane("review:").props.hidden).toBe(false);
  expect(pane(term.id).props.hidden).toBe(true);
  const review = nodes(pane("review:")).find((n) => n.type === ReviewView)!;
  expect(review.props).toMatchObject({ api, worktree: OAK, reveal: { file: "src/session.ts", seq: 1 } });

  // Closing the diff hands the view back to the terminal.
  tabs.find((n) => n.props["aria-label"] === en("workspace.tabs.close", { name: en("review.tab") }))!.props.onClick();
  expect(tabs.find((n) => n.props["data-tab"] === "review:")).toBeUndefined();
  expect(pane(term.id).props.hidden).toBe(false);
});

it("commits only the checked files and refreshes", async () => {
  const api = createMockApi({});
  const commit = vi.spyOn(api, "worktreeCommit");
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  view.box("docs/old-notes.md").props.onChange();
  expect(view.box("docs/old-notes.md").props.checked).toBe(false);
  expect(view.commit().props.children).toBe(en("workspace.changes.commit", { count: 2 }));
  view.message().props.onChange({ target: { value: "   " } });
  expect(view.commit().props.disabled).toBe(true);
  view.message().props.onChange({ target: { value: "feat: status line" } });
  expect(view.commit().props.disabled).toBe(false);

  view.commit().props.onClick();
  await tick();
  expect(commit).toHaveBeenCalledWith(OAK, ["src/session.ts", "src/status.ts"], "feat: status line");
  expect(list).toHaveBeenCalledTimes(2);
  expect(view.rows()).toHaveLength(1);
  expect(view.message().props.value).toBe("");
  expect(view.onCount).toHaveBeenLastCalledWith(1);

  // Coming back to the window looks again.
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(list).toHaveBeenCalledTimes(3);
  for (const cleanup of view.cleanups) if (typeof cleanup === "function") cleanup();
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(list).toHaveBeenCalledTimes(3);
});

it("refreshes when a tab of the worktree goes from working to idle", async () => {
  vi.useFakeTimers();
  const api = createMockApi({});
  const list = vi.spyOn(api, "worktreeChanges");
  let clock = 1000;
  const live = (sessions = new Sessions(api, () => clock));
  const agent = live.open(OAK, "claude");
  const other = live.open("/demo/wt/xdev-elm", "claude");
  changes(api, live);
  await tick();
  expect(list).toHaveBeenCalledTimes(1);

  live.noteOutput(agent.id, 10);
  live.noteOutput(other.id, 10);
  await tick();
  expect(list).toHaveBeenCalledTimes(1);
  clock += 3000;
  await vi.advanceTimersByTimeAsync(1000);
  await tick();
  expect(live.tabs(OAK)[0].status).toBe("idle");
  // Only this worktree's tab counts, and it counts once.
  expect(list).toHaveBeenCalledTimes(2);
});

it("shows git_identity inline", async () => {
  const api = createMockApi({});
  const commit = vi.spyOn(api, "worktreeCommit").mockRejectedValueOnce({ code: "git_identity" });
  const view = changes(api);
  await tick();
  view.message().props.onChange({ target: { value: "feat: status line" } });
  view.commit().props.onClick();
  await tick();
  let html = view.html();
  expect(html).toContain(en("error.git_identity"));
  expect(html).toContain("git config --global user.name");
  // The message stays for the next try.
  expect(view.message().props.value).toBe("feat: status line");
  // A refresh in between keeps the commit's error.
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(view.html()).toContain(en("error.git_identity"));

  commit.mockRejectedValueOnce({ code: "git", detail: "pre-commit hook failed" });
  view.commit().props.onClick();
  await tick();
  html = view.html();
  expect(html).not.toContain(en("error.git_identity"));
  expect(html).toContain(en("error.git"));
  expect(html).toContain("pre-commit hook failed");

  commit.mockRejectedValueOnce({ code: "empty_message" });
  view.commit().props.onClick();
  await tick();
  expect(view.html()).toContain(en("error.empty_message"));
});

it("shows the binary placeholder", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "worktreeReviewFile").mockResolvedValueOnce({ old: null, new: null, skip: "binary" });
  const binary = mount(() => section(api, "docs/logo.png"));
  await tick();
  expect(read).toHaveBeenCalledWith(OAK, START, "docs/logo.png");
  expect(binary.html()).toContain(en("workspace.diff.binary"));
  expect(binary.find((n) => n.type === DiffView)).toBeUndefined();

  read.mockResolvedValueOnce({ old: null, new: null, skip: "too_large" });
  const large = mount(() => section(api, "data/dump.sql"));
  await tick();
  expect(large.html()).toContain(en("workspace.diff.tooLarge"));
  expect(large.find((n) => n.type === DiffView)).toBeUndefined();
});

const FILES = ["docs/old-notes.md", "src/session.ts", "src/status.ts"];
const key = (extra: object = {}) => ({ key: "Enter", ctrlKey: true, preventDefault: vi.fn(), ...extra });

it("ctrl+enter commits", async () => {
  const api = createMockApi({});
  const commit = vi.spyOn(api, "worktreeCommit");
  const onShipChanged = vi.fn();
  const view = changes(api, undefined, { onShipChanged });
  await tick();
  view.message().props.onChange({ target: { value: "feat: status line" } });
  const event = key();
  view.message().props.onKeyDown(event);
  await tick();
  expect(event.preventDefault).toHaveBeenCalled();
  expect(commit).toHaveBeenCalledWith(OAK, FILES, "feat: status line");
  expect(onShipChanged).toHaveBeenCalledTimes(1);
  // Cmd+Enter does the same.
  const other = createMockApi({});
  const cmd = vi.spyOn(other, "worktreeCommit");
  const mac = changes(other);
  await tick();
  mac.message().props.onChange({ target: { value: "again" } });
  mac.message().props.onKeyDown(key({ ctrlKey: false, metaKey: true }));
  await tick();
  expect(cmd).toHaveBeenCalledTimes(1);
});

it("ctrl+enter does nothing with an empty message", async () => {
  const api = createMockApi({});
  const commit = vi.spyOn(api, "worktreeCommit");
  const view = changes(api);
  await tick();
  view.message().props.onKeyDown(key());
  view.message().props.onKeyDown(key({ ctrlKey: false }));
  await tick();
  expect(commit).not.toHaveBeenCalled();
});

it("draft fills the message", async () => {
  const api = createMockApi({});
  const draft = vi.spyOn(api, "worktreeDraftCommit");
  const commit = vi.spyOn(api, "worktreeCommit");
  const view = changes(api);
  await tick();
  const button = () => view.find((n) => n.type === "button" && n.props.children === en("ship.draft"))!;
  button().props.onClick();
  expect(view.find((n) => n.type === "button" && n.props.children === en("ship.drafting"))!.props.disabled).toBe(true);
  await tick();
  expect(draft).toHaveBeenCalledWith(OAK, FILES);
  expect(view.message().props.value).toBe("Update 3 files");
  // Drafting never commits by itself.
  expect(commit).not.toHaveBeenCalled();
  vi.spyOn(api, "worktreeDraftCommit").mockRejectedValueOnce({ code: "draft_failed" });
  button().props.onClick();
  await tick();
  expect(view.html()).toContain(en("error.draft_failed"));
});

it("amend pushed asks then confirms", async () => {
  const api = createMockApi({});
  const amend = vi.spyOn(api, "worktreeAmend")
    .mockRejectedValueOnce({ code: "amend_pushed" })
    .mockResolvedValueOnce("c".repeat(40));
  const commit = vi.spyOn(api, "worktreeCommit");
  const view = changes(api);
  await tick();
  view.find((n) => n.type === "input" && n.props["aria-label"] === undefined && n.props.type === "checkbox" && n.props.checked === false)!.props.onChange();
  view.message().props.onChange({ target: { value: "fix: reword" } });
  expect(view.commit().props.children).toBe(en("ship.amend.button"));
  view.commit().props.onClick();
  await tick();
  expect(amend).toHaveBeenLastCalledWith(OAK, FILES, "fix: reword", false);
  const dialog = () => view.find((n) => n.type === ConfirmDialog)!;
  expect(dialog().props.open).toBe(true);
  expect(dialog().props.body).toBe("This commit is already on the remote. Amending it means the next push must be a force push.");
  dialog().props.onConfirm();
  await tick();
  expect(amend).toHaveBeenLastCalledWith(OAK, FILES, "fix: reword", true);
  expect(dialog().props.open).toBe(false);
  expect(commit).not.toHaveBeenCalled();
});

it("hook failure shows output and fix with agent sends it", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeCommit").mockRejectedValueOnce({ code: "hook_failed", detail: "eslint: 3 errors" });
  const onFixWithAgent = vi.fn();
  const view = changes(api, undefined, { onFixWithAgent });
  await tick();
  view.message().props.onChange({ target: { value: "feat: x" } });
  view.commit().props.onClick();
  await tick();
  const pre = view.find((n) => n.type === "pre")!;
  expect(pre.props.children).toBe("eslint: 3 errors");
  view.find((n) => n.type === "button" && n.props.children === en("ship.hook.fix"))!.props.onClick();
  expect(onFixWithAgent).toHaveBeenCalledWith("eslint: 3 errors");
  // Without the prop the button is hidden.
  const bare = changes(api);
  await tick();
  bare.message().props.onChange({ target: { value: "x" } });
  vi.spyOn(api, "worktreeCommit").mockRejectedValueOnce({ code: "hook_failed", detail: "boom" });
  bare.commit().props.onClick();
  await tick();
  expect(bare.html()).toContain("boom");
  expect(bare.html()).not.toContain(en("ship.hook.fix"));
});

// ---- Source control groups ----

const mixed = [
  { path: "docs/old-notes.md", staged: true, unstaged: false, untracked: false },
  { path: "src/session.ts", staged: true, unstaged: true, untracked: false },
  { path: "src/status.ts", staged: false, unstaged: true, untracked: true },
];
const group = (view: ReturnType<typeof changes>, name: string) => view.all().find((n) => n.props["data-group"] === name);
const inGroup = (view: ReturnType<typeof changes>, name: string) =>
  nodes(group(view, name)).filter((n) => n.type === "li").map((li) => nodes(li).find((n) => n.props.title && FILES.includes(n.props.title))!.props.title);
const labelled = (root: Node | undefined, label: string) => nodes(root).find((n) => n.props["aria-label"] === label)!;

it("splits the list into Staged and Changes, a file with both in both", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const view = changes(api);
  await tick();
  expect(inGroup(view, "staged")).toEqual(["docs/old-notes.md", "src/session.ts"]);
  expect(inGroup(view, "changes")).toEqual(["src/session.ts", "src/status.ts"]);
  const html = view.html();
  expect(html).toContain(en("changes.group.staged"));
  expect(html).toContain(en("changes.group.changes"));
  // Each header shows its count.
  expect(renderToStaticMarkup(group(view, "staged")!)).toContain("2");
  expect(renderToStaticMarkup(group(view, "changes")!)).toContain("2");
});

it("hides an empty group", async () => {
  const api = createMockApi({});
  const view = changes(api);
  await tick();
  // Nothing staged in the mock: only Changes.
  expect(group(view, "staged")).toBeUndefined();
  expect(inGroup(view, "changes")).toEqual(FILES);
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(FILES.map((path) => ({ path, staged: true, unstaged: false, untracked: false })));
  window.dispatchEvent(new Event("focus"));
  await tick();
  expect(group(view, "changes")).toBeUndefined();
  expect(inGroup(view, "staged")).toEqual(FILES);
});

it("falls back to one Changes group when the stage state cannot be read", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockRejectedValue({ code: "git" });
  const view = changes(api);
  await tick();
  expect(inGroup(view, "changes")).toEqual(FILES);
  expect(group(view, "staged")).toBeUndefined();
});

it("Stage All stages every file of Changes, then reads again", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  const before = list.mock.calls.length;
  labelled(group(view, "changes"), en("changes.stageAll")).props.onClick();
  await tick();
  expect(stage).toHaveBeenCalledWith(OAK, ["src/session.ts", "src/status.ts"], true);
  expect(list.mock.calls.length).toBe(before + 1);
});

it("a stage here tells the review tab, and a stage there reads the list again", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  const told = vi.fn();
  onChangesTouched(OAK, told);
  labelled(group(view, "changes"), en("changes.stageAll")).props.onClick();
  await tick();
  expect(told).toHaveBeenCalledTimes(1);
  const before = list.mock.calls.length;
  touchChanges(OAK);
  await tick();
  expect(list.mock.calls.length).toBe(before + 1);
});

it("Unstage All unstages every file of Staged", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const states = vi.spyOn(api, "worktreeStageState");
  const view = changes(api);
  await tick();
  const before = states.mock.calls.length;
  labelled(group(view, "staged"), en("changes.unstageAll")).props.onClick();
  await tick();
  expect(stage).toHaveBeenCalledWith(OAK, ["docs/old-notes.md", "src/session.ts"], false);
  expect(states.mock.calls.length).toBe(before + 1);
});

it("a row stages or unstages one file and keeps its open button", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  const rowIn = (name: string, path: string) => nodes(group(view, name)).filter((n) => n.type === "li").find((li) => nodes(li).some((n) => n.props.title === path))!;
  labelled(rowIn("changes", "src/status.ts"), en("changes.stage", { path: "src/status.ts" })).props.onClick();
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["src/status.ts"], true);
  labelled(rowIn("staged", "docs/old-notes.md"), en("changes.unstage", { path: "docs/old-notes.md" })).props.onClick();
  await tick();
  expect(stage).toHaveBeenLastCalledWith(OAK, ["docs/old-notes.md"], false);
  // The row still opens the file.
  nodes(rowIn("changes", "src/status.ts")).find((n) => n.props.className === "ws-change-open")!.props.onClick();
  expect(view.onOpenFile).toHaveBeenCalledWith("src/status.ts");
});

it("shows the error of a failed stage and still reads again", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStage").mockRejectedValue({ code: "git", detail: "index.lock exists" });
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  const before = list.mock.calls.length;
  labelled(group(view, "changes"), en("changes.stageAll")).props.onClick();
  await tick();
  expect(view.html()).toContain("index.lock exists");
  expect(list.mock.calls.length).toBe(before + 1);
});

// ---- Discard ----

const dialog = (view: ReturnType<typeof changes>) => view.find((n) => n.type === ConfirmDialog && n.props.confirmLabel === en("changes.discard.confirm"))!;
const rowOf = (view: ReturnType<typeof changes>, name: string, path: string) =>
  nodes(group(view, name)).filter((n) => n.type === "li").find((li) => nodes(li).some((n) => n.props.title === path))!;
const hasStagedBox = (view: ReturnType<typeof changes>) => nodes(dialog(view).props.children).find((n) => n.type === "input");

it("offers Discard in Changes rows only, and asks before doing anything", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  const label = (path: string) => en("changes.discard", { path });
  expect(nodes(rowOf(view, "staged", "docs/old-notes.md")).some((n) => n.props["aria-label"] === label("docs/old-notes.md"))).toBe(false);
  expect(dialog(view).props.open).toBe(false);
  labelled(rowOf(view, "changes", "src/status.ts"), label("src/status.ts")).props.onClick();
  expect(dialog(view).props.open).toBe(true);
  expect(dialog(view).props.title).toBe(en("changes.discard.title", { path: "src/status.ts" }));
  expect(dialog(view).props.body).toBe(en("changes.discard.body"));
  expect(discard).not.toHaveBeenCalled();
});

it("cancel calls nothing and closes the dialog", async () => {
  const api = createMockApi({});
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  expect(dialog(view).props.open).toBe(true);
  dialog(view).props.onCancel();
  expect(dialog(view).props.open).toBe(false);
  await tick();
  expect(discard).not.toHaveBeenCalled();
});

it("confirming a file calls with confirmed set and without the staged flag", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  const before = list.mock.calls.length;
  labelled(rowOf(view, "changes", "src/status.ts"), en("changes.discard", { path: "src/status.ts" })).props.onClick();
  // Untracked: nothing staged to ask about.
  expect(hasStagedBox(view)).toBeUndefined();
  dialog(view).props.onConfirm();
  await tick();
  expect(discard).toHaveBeenCalledWith(OAK, ["src/status.ts"], false, true);
  expect(dialog(view).props.open).toBe(false);
  expect(list.mock.calls.length).toBe(before + 1);
});

it("the staged checkbox shows only for a staged file and is passed on", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  labelled(rowOf(view, "changes", "src/session.ts"), en("changes.discard", { path: "src/session.ts" })).props.onClick();
  const box = hasStagedBox(view)!;
  expect(renderToStaticMarkup(dialog(view).props.children)).toContain(en("changes.discard.staged"));
  expect(box.props.checked).toBe(false);
  box.props.onChange();
  expect(hasStagedBox(view)!.props.checked).toBe(true);
  dialog(view).props.onConfirm();
  await tick();
  expect(discard).toHaveBeenCalledWith(OAK, ["src/session.ts"], true, true);
  // A later dialog starts unchecked again.
  labelled(rowOf(view, "changes", "src/session.ts"), en("changes.discard", { path: "src/session.ts" })).props.onClick();
  expect(hasStagedBox(view)!.props.checked).toBe(false);
});

it("Discard All names the count and lists every file of Changes", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  expect(dialog(view).props.title).toBe(en("changes.discard.titleMany", { count: 2 }));
  dialog(view).props.onConfirm();
  await tick();
  expect(discard).toHaveBeenCalledWith(OAK, ["src/session.ts", "src/status.ts"], false, true);
});

it("warns when an agent is working in the worktree", async () => {
  const api = createMockApi({});
  const quiet = changes(api);
  await tick();
  labelled(group(quiet, "changes"), en("changes.discardAll")).props.onClick();
  expect(dialog(quiet).props.warning).toBeUndefined();

  const busy = { dot: () => "working", tabs: () => [{ id: "a", agent: true, status: "working" }], subscribe: () => () => {} } as unknown as Sessions;
  const view = changes(api, busy);
  await tick();
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  expect(dialog(view).props.warning).toBe(en("changes.discard.agent"));
});

it("warns while any agent is still mid-turn, even when another one's status is more urgent", async () => {
  const api = createMockApi({});
  // The worktree dot shows the most urgent tab, so a finished agent would hide a working one.
  for (const [dot, statuses] of [
    ["done", ["done", "working"]],
    ["needs-you", ["needs-you"]],
  ] as const) {
    const tabs = statuses.map((status, i) => ({ id: `t${i}`, agent: true, status }));
    const sessions = { dot: () => dot, tabs: () => tabs, subscribe: () => () => {} } as unknown as Sessions;
    const view = changes(api, sessions);
    await tick();
    labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
    expect(dialog(view).props.warning, dot).toBe(en("changes.discard.agent"));
  }
  // A shell tab that is busy is not an agent.
  const shell = { dot: () => null, tabs: () => [{ id: "s", agent: false, status: "working" }], subscribe: () => () => {} } as unknown as Sessions;
  const view = changes(api, shell);
  await tick();
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  expect(dialog(view).props.warning).toBeUndefined();
});

it("shows the policy's reason when discard is denied, and reads again", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeDiscard").mockRejectedValue({ code: "denied", detail: "discarding is off today" });
  const list = vi.spyOn(api, "worktreeChanges");
  const view = changes(api);
  await tick();
  const before = list.mock.calls.length;
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  dialog(view).props.onConfirm();
  await tick();
  expect(view.html()).toContain("discarding is off today");
  expect(list.mock.calls.length).toBe(before + 1);
});

it("never shows needs_approval, the dialog was the approval", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeDiscard").mockRejectedValue({ code: "needs_approval", detail: "asks" });
  const view = changes(api);
  await tick();
  labelled(group(view, "changes"), en("changes.discardAll")).props.onClick();
  dialog(view).props.onConfirm();
  await tick();
  expect(view.html()).not.toContain(en("error.needs_approval"));
});

// ---- Keyboard and palette hooks ----

const press = (row: Node, key: string, extra: Record<string, unknown> = {}) => {
  const event = { key, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, preventDefault: vi.fn(), ...extra };
  row.props.onKeyDown(event);
  return event;
};

it("rows are focusable and s stages the focused Changes row", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  const row = rowOf(view, "changes", "src/status.ts");
  expect(row.props.tabIndex).toBe(0);
  const event = press(row, "s");
  await tick();
  expect(event.preventDefault).toHaveBeenCalled();
  expect(stage).toHaveBeenCalledWith(OAK, ["src/status.ts"], true);
  // u on a Changes row does nothing.
  stage.mockClear();
  press(row, "u");
  await tick();
  expect(stage).not.toHaveBeenCalled();
});

it("u unstages the focused Staged row, and s there does nothing", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  const row = rowOf(view, "staged", "docs/old-notes.md");
  press(row, "s");
  await tick();
  expect(stage).not.toHaveBeenCalled();
  press(row, "u");
  await tick();
  expect(stage).toHaveBeenCalledWith(OAK, ["docs/old-notes.md"], false);
});

it("Delete on a Changes row opens the discard confirm and calls nothing yet", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const discard = vi.spyOn(api, "worktreeDiscard").mockResolvedValue(undefined);
  const view = changes(api);
  await tick();
  press(rowOf(view, "changes", "src/status.ts"), "Delete");
  expect(dialog(view).props.open).toBe(true);
  expect(dialog(view).props.title).toBe(en("changes.discard.title", { path: "src/status.ts" }));
  expect(discard).not.toHaveBeenCalled();
  // Delete in Staged is not a discard.
  dialog(view).props.onCancel();
  press(rowOf(view, "staged", "docs/old-notes.md"), "Delete");
  expect(dialog(view).props.open).toBe(false);
});

it("keys with a modifier are left alone, Ctrl+Enter commits", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const commit = vi.spyOn(api, "worktreeCommit").mockResolvedValue("abc");
  const view = changes(api);
  await tick();
  const row = rowOf(view, "changes", "src/status.ts");
  press(row, "s", { ctrlKey: true });
  await tick();
  expect(stage).not.toHaveBeenCalled();
  // No message yet: the commit waits.
  press(row, "Enter", { ctrlKey: true });
  await tick();
  expect(commit).not.toHaveBeenCalled();
  view.message().props.onChange({ target: { value: "feat: x" } });
  press(rowOf(view, "changes", "src/status.ts"), "Enter", { ctrlKey: true });
  await tick();
  expect(commit).toHaveBeenCalledWith(OAK, FILES, "feat: x");
});

it("hands the palette its Stage all and Discard all handlers", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "worktreeStageState").mockResolvedValue(mixed);
  const stage = vi.spyOn(api, "worktreeStage").mockResolvedValue(undefined);
  const register = vi.fn();
  const view = changes(api, undefined, { register });
  await tick();
  expect(register).toHaveBeenCalledTimes(1);
  const handlers = register.mock.calls[0][0];
  // The list drew again after its load, as React would; the handlers see that draw.
  view.draw();
  handlers.stageAll();
  await tick();
  expect(stage).toHaveBeenCalledWith(OAK, ["src/session.ts", "src/status.ts"], true);
  handlers.discardAll();
  expect(dialog(view).props.open).toBe(true);
  expect(dialog(view).props.title).toBe(en("changes.discard.titleMany", { count: 2 }));
  // Leaving takes them back.
  view.cleanups.forEach((c) => typeof c === "function" && c());
  expect(register).toHaveBeenLastCalledWith(null);
});
