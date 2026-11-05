import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Disclosure, IconButton, SplitHandle } from "@xdev-asia/ui";
import type { Api, CommitFiles, LogCommit, RepoLog } from "@/api";
import { translate } from "@/i18n";
import { ContextMenu } from "@/ui/ContextMenu";
import { HistoryPanel, setHistoryOpen } from "./HistoryPanel";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return { index, values };
  };
  return {
    ...react,
    useState: (initial: any) => {
      if (!hooks.active) return react.useState(initial);
      const { index, values } = slot(initial);
      return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
    },
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const { index, values } = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
const toasts = vi.hoisted(() => ({ pushed: [] as { id: string; text: string }[] }));
vi.mock("./toastStore", () => ({ pushToast: (toast: { id: string; text: string }) => void toasts.pushed.push(toast) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.actions)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const WT = "/demo/wt/oak";

const commit = (id: string, parents: string[]): LogCommit => ({ id, parents, author: "Ada", email: "ada@example.test", time: 1_700_000_000, subject: `subject ${id}`, body: "", refs: [] });
function log(over: Partial<RepoLog> = {}): RepoLog {
  return { commits: [commit("aaaaaaa1", ["bbbbbbb2"]), commit("bbbbbbb2", [])], head: "aaaaaaa1", branch: "oak", upstream: null, base: null, mergeBase: "bbbbbbb2", incoming: false, outgoing: false, hasMore: false, ...over };
}
const FILES: CommitFiles = { files: [{ path: "src/app.ts", status: "modified" }, { path: "README.md", status: "added" }] } as CommitFiles;

function stub(over: Record<string, unknown> = {}) {
  const api = {
    worktreeLog: vi.fn(async () => log()),
    worktreeCommitFiles: vi.fn(async () => FILES),
    worktreeOpenCommit: vi.fn(async () => undefined),
    ...over,
  };
  return api as typeof api & Api;
}

function panel(api: Api, extra: { reloadKey?: number; visible?: boolean } = {}) {
  const values: unknown[] = [];
  const onOpenCommit = vi.fn();
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return HistoryPanel({ api, worktree: WT, onOpenCommit, ...extra }); } finally { hooks.active = false; }
  };
  const run = () => { const before = hooks.effects.length; draw(); return hooks.effects.slice(before).map((e) => e()); };
  const all = () => nodes(draw());
  const html = () => renderToStaticMarkup(draw() as ReactElement);
  const row = (id: string) => all().find((n) => n.type === "button" && typeof n.props["aria-label"] === "string" && n.props["aria-label"].includes(id))!;
  const refresh = () => all().find((n) => n.type === IconButton && n.props.icon === "restore")!;
  return { draw, run, all, html, row, refresh, onOpenCommit };
}

beforeEach(() => {
  toasts.pushed.length = 0;
  setHistoryOpen(WT, false);
});

it("is collapsed by default and reads nothing", async () => {
  const api = stub();
  const p = panel(api);
  p.run();
  await tick();
  expect(api.worktreeLog).not.toHaveBeenCalled();
  expect(p.all().some((n) => n.type === SplitHandle)).toBe(false);
  expect(p.all().find((n) => n.type === Disclosure)!.props.expanded).toBe(false);
});

it("loads the newest fifty once open, and shows the rows", async () => {
  setHistoryOpen(WT, true);
  const api = stub();
  const p = panel(api);
  p.run();
  await tick();
  expect(api.worktreeLog).toHaveBeenCalledWith(WT, 50, 0);
  const html = p.html();
  expect(html).toContain("subject aaaaaaa1");
  expect(p.row("aaaaaaa").props["aria-label"]).toBe(en("gitHistory.row.show", { id: "aaaaaaa", subject: "subject aaaaaaa1" }));
  expect(p.all().find((n) => n.type === SplitHandle)!.props.label).toBe(en("gitHistory.resize"));
});

it("reads nothing while not visible", async () => {
  setHistoryOpen(WT, true);
  const api = stub();
  panel(api, { visible: false }).run();
  await tick();
  expect(api.worktreeLog).not.toHaveBeenCalled();
});

it("says it is loading, then that there are no commits", async () => {
  setHistoryOpen(WT, true);
  const api = stub({ worktreeLog: vi.fn(async () => log({ commits: [] })) });
  const p = panel(api);
  p.run();
  expect(p.html()).toContain(en("gitHistory.loading"));
  await tick();
  expect(p.html()).toContain(en("gitHistory.empty"));
});

it("shows a failed read as its error code", async () => {
  setHistoryOpen(WT, true);
  const api = stub({ worktreeLog: vi.fn(async () => { throw { code: "open_failed", message: "x" }; }) });
  const p = panel(api);
  p.run();
  await tick();
  expect(p.html()).toContain(en("error.open_failed"));
});

it("refresh while collapsed expands, and while open reads again", async () => {
  const api = stub();
  const p = panel(api);
  p.run();
  p.refresh().props.onClick();
  expect(p.all().find((n) => n.type === Disclosure)!.props.expanded).toBe(true);
  p.run();
  await tick();
  expect(api.worktreeLog).toHaveBeenCalledTimes(1);
});

it("shows the meta line and the files of an expanded commit, and opens them", async () => {
  setHistoryOpen(WT, true);
  const api = stub();
  const p = panel(api);
  p.run();
  await tick();
  p.row("aaaaaaa").props.onClick();
  await tick();
  expect(api.worktreeCommitFiles).toHaveBeenCalledWith(WT, "aaaaaaa1");
  const html = p.html();
  expect(html).toContain("Ada · ");
  expect(html).toContain("app.ts");
  expect(p.row("aaaaaaa").props["aria-label"]).toBe(en("gitHistory.row.hide", { id: "aaaaaaa", subject: "subject aaaaaaa1" }));
  const file = p.all().find((n) => n.props.className === "ws-history-file")!;
  file.props.onClick();
  expect(p.onOpenCommit).toHaveBeenCalledWith("aaaaaaa1", "src/app.ts");
  p.all().find((n) => n.props.children === en("gitHistory.openAll"))!.props.onClick();
  expect(p.onOpenCommit).toHaveBeenCalledWith("aaaaaaa1", null);
});

it("says a commit has no file changes", async () => {
  setHistoryOpen(WT, true);
  const api = stub({ worktreeCommitFiles: vi.fn(async () => ({ files: [] })) });
  const p = panel(api);
  p.run();
  await tick();
  p.row("aaaaaaa").props.onClick();
  await tick();
  expect(p.html()).toContain(en("gitHistory.files.none"));
});

it("has three context menu items, and none on the boundary rows", async () => {
  setHistoryOpen(WT, true);
  const api = stub({ worktreeLog: vi.fn(async () => log({ outgoing: true })) });
  const p = panel(api);
  p.run();
  await tick();
  expect(p.html()).toContain(en("gitHistory.outgoing"));
  expect(p.all().filter((n) => n.props.onContextMenu).length).toBe(2);
  p.row("aaaaaaa").props.onContextMenu({ preventDefault() {}, clientX: 5, clientY: 6 });
  const menu = p.all().find((n) => n.type === ContextMenu)!;
  expect(menu.props.items.map((i: { id: string }) => i.id)).toEqual(["open", "hash", "message"]);
});

it("copies the hash and the message and says so", async () => {
  setHistoryOpen(WT, true);
  const writeText = vi.fn(async () => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  const api = stub();
  const p = panel(api);
  p.run();
  await tick();
  p.row("aaaaaaa").props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
  const items = p.all().find((n) => n.type === ContextMenu)!.props.items;
  items[1].run();
  await tick();
  expect(writeText).toHaveBeenCalledWith("aaaaaaa1");
  expect(toasts.pushed.at(-1)!.text).toBe(en("gitHistory.copied", { what: en("gitHistory.what.hash") }));
  items[2].run();
  await tick();
  expect(writeText).toHaveBeenLastCalledWith("subject aaaaaaa1");
  writeText.mockRejectedValueOnce(new Error("no"));
  items[1].run();
  await tick();
  expect(toasts.pushed.at(-1)!.text).toBe(en("gitHistory.copyFailed", { what: en("gitHistory.what.hash") }));
  vi.unstubAllGlobals();
});

it("toasts when the commit cannot be opened in the browser", async () => {
  setHistoryOpen(WT, true);
  const api = stub({ worktreeOpenCommit: vi.fn(async () => { throw { code: "no_web_remote", message: "x" }; }) });
  const p = panel(api);
  p.run();
  await tick();
  p.row("aaaaaaa").props.onContextMenu({ preventDefault() {}, clientX: 0, clientY: 0 });
  p.all().find((n) => n.type === ContextMenu)!.props.items[0].run();
  await tick();
  expect(api.worktreeOpenCommit).toHaveBeenCalledWith(WT, "aaaaaaa1");
  expect(toasts.pushed.at(-1)!.text).toBe(en("gitHistory.noWebRemote"));
  api.worktreeOpenCommit.mockRejectedValueOnce({ code: "open_failed", message: "x" });
  p.all().find((n) => n.type === ContextMenu)!.props.items[0].run();
  await tick();
  expect(toasts.pushed.at(-1)!.text).toBe(en("gitHistory.openFailed"));
});
