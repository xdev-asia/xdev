import { expect, it, vi } from "vitest";
import type { ReviewBranch } from "@/api";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { createMockApi } from "@/mockApi";
import { buildCreate, CreateWorktreeDialog, PreviewHint } from "./CreateWorktreeDialog";
import { BaseRefField } from "./BaseRefField";
import { parseItem } from "./workItemInput";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  // Stateful only while `mount` draws; elsewhere the dialog is called once with its initial state.
  const state = (initial: unknown) => {
    if (!hooks.active) return [initial, () => {}];
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return { ...react, useState: state, useRef: () => ({ current: null }), useEffect: (effect: any) => void (hooks.active && hooks.effects.push(effect)) };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const AGENTS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];
const BLANK = { text: "", agent: "claude", defaultAgent: "claude", setDefault: false, parent: "", itemUrl: "", itemKind: "pr" as const };

it("preselects the default agent and lists No agent first", () => {
  const repos = DEMO_WORKSPACE.repos;
  const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, agents: AGENTS, defaultAgent: "claude", onCreate: vi.fn(), onCancel: vi.fn() }));
  const select = all.find((n) => n.type === "select" && n.props.value === "claude")!;
  expect(select).toBeDefined();
  const options = nodes(select.props.children).filter((n) => n.type === "option");
  expect(options.map((o) => o.props.value)).toEqual(["", "claude", "codex"]);
});

it("sends the picked agent and Set as default only when it differs from the default", () => {
  expect(buildCreate({ ...BLANK, agent: "codex", setDefault: true })?.extra).toMatchObject({ agent: "codex", setDefault: true });
  expect(buildCreate({ ...BLANK, agent: "claude", setDefault: true })?.extra).toMatchObject({ agent: "claude", setDefault: false });
  expect(buildCreate({ ...BLANK, agent: "", setDefault: true })?.extra).toMatchObject({ agent: null, setDefault: false });
});

it("sends the parent and the work item", () => {
  const built = buildCreate({ ...BLANK, parent: "/w/oak", itemUrl: "https://x.test/i/7", itemKind: "issue" });
  expect(built?.extra.parent).toBe("/w/oak");
  expect(built?.extra.item).toEqual({ kind: "issue", url: "https://x.test/i/7", title: null });
});

it("refuses a link that is not a URL", () => {
  expect(parseItem("not a link", "pr")).toBe("bad");
  expect(parseItem("ftp://x.test/1", "pr")).toBe("bad");
  expect(buildCreate({ ...BLANK, itemUrl: "nope" })).toBeNull();
  expect(parseItem("  ", "pr")).toBeNull();
});

it("keeps the emoji in the title and uses the code word in the name", () => {
  const built = buildCreate({ ...BLANK, text: "🚀 login" });
  expect(built?.name).toBe("rocket-login");
  expect(built?.extra.title).toBe("🚀 login");
  const plain = buildCreate({ ...BLANK, text: "feat/login" });
  expect(plain?.name).toBe("feat/login");
  expect(plain?.extra.title).toBeNull();
});

it("shows what a taken name will be created as, and nothing otherwise", () => {
  const taken = { branch: "feat-one-2", folder: "xdev-feat-one-2", suffixed: true };
  const hint = PreviewHint({ preview: taken }) as Node;
  expect(hint.props.children).toBe("Will be created as xdev-feat-one-2 on branch feat-one-2");
  expect(PreviewHint({ preview: { ...taken, suffixed: false } })).toBeNull();
  expect(PreviewHint({ preview: null })).toBeNull();
});

it("the name field is followed by the preview slot", () => {
  const repos = DEMO_WORKSPACE.repos;
  const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, onCreate: vi.fn(), onCancel: vi.fn() }));
  expect(all.some((n) => n.type === PreviewHint)).toBe(true);
});

it("carries the note, which the shell saves as the comment", () => {
  expect(buildCreate({ ...BLANK, note: "  check the footer  " })?.extra).toMatchObject({ note: "check the footer" });
  expect(buildCreate({ ...BLANK, note: "   " })?.extra).not.toHaveProperty("note");
  expect(buildCreate(BLANK)?.extra).not.toHaveProperty("note");
});

it("keeps Advanced closed and offers Create more", () => {
  const repos = DEMO_WORKSPACE.repos;
  const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, agents: AGENTS, onCreate: vi.fn(), onCancel: vi.fn() }));
  const adv = all.find((n) => n.props.title === translate("en", "workspace.create.advanced"));
  expect(adv?.props.defaultExpanded).toBe(false);
  expect(all.some((n) => n.props.label === translate("en", "workspace.create.createMore"))).toBe(true);
});

it("offers the Branch tab only when branches can be read, and keeps a base field on the Name tab", () => {
  const repos = DEMO_WORKSPACE.repos;
  const tabs = (branches?: () => Promise<never[]>) => {
    const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, agents: AGENTS, branches, onCreate: vi.fn(), onCancel: vi.fn() }));
    return all.find((n) => Array.isArray(n.props.options) && n.props.label === translate("en", "workspace.create.tab.label"))!.props.options.map((o: { value: string }) => o.value);
  };
  expect(tabs()).toEqual(["name"]);
  expect(tabs(async () => [])).toEqual(["name", "branch"]);
});

it("offers the GitHub tab only with a search api and both start handlers", () => {
  const repos = DEMO_WORKSPACE.repos;
  const values = (extra: Record<string, unknown>) => {
    const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, onCreate: vi.fn(), onCancel: vi.fn(), ...extra } as never));
    return all.find((n) => n.props.label === translate("en", "workspace.create.tab.label"))!.props.options.map((o: { value: string }) => o.value);
  };
  expect(values({})).toEqual(["name"]);
  expect(values({ api: createMockApi({}), onStartIssue: vi.fn(), onStartPr: vi.fn() })).toEqual(["name", "github"]);
});

const en = (key: string) => translate("en", key);
const flush = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
const BRANCHES: ReviewBranch[] = [
  { name: "main", remote: false },
  { name: "keep-me", remote: false },
  { name: "origin/other", remote: true },
];

// Draws the dialog with its own hook values; a commit runs the effects as after a commit.
function mount(over: Record<string, unknown> = {}) {
  const repos = DEMO_WORKSPACE.repos;
  const onCreate = vi.fn();
  const onCancel = vi.fn();
  const values: unknown[] = [];
  const cleanups: (void | (() => void))[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try {
      return CreateWorktreeDialog({ repos, repoId: repos[0].id, agents: AGENTS, onCreate, onCancel, ...over } as never);
    } finally { hooks.active = false; }
  };
  const commit = () => {
    cleanups.splice(0).forEach((c) => typeof c === "function" && c());
    hooks.effects = [];
    const tree = draw();
    cleanups.push(...hooks.effects.map((effect) => effect()));
    return tree;
  };
  let tree = commit();
  const all = () => nodes(tree);
  const redraw = () => (tree = commit());
  const typeName = (text: string) => { all().find((n) => n.type === "input" && n.props.autoFocus)!.props.onChange({ target: { value: text } }); redraw(); };
  const setSparse = (text: string) => { all().find((n) => n.type === "textarea" && n.props.className === "ws-mono")!.props.onChange({ target: { value: text } }); redraw(); };
  const create = () => all().find((n) => n.props.type === "submit")!;
  const submit = () => all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  const keydown = (init: Record<string, unknown>) => all().find((n) => n.type === "form")!.props.onKeyDown({ preventDefault() {}, ...init });
  const tab = (value: string) => { all().find((n) => n.props.label === en("workspace.create.tab.label"))!.props.onChange(value); redraw(); };
  const branchSelect = () => all().find((n) => n.type === "select" && n.props["aria-label"] === en("workspace.create.branchMode.existing"));
  return { all, redraw, typeName, setSparse, create, submit, keydown, tab, branchSelect, onCreate, onCancel, repo: repos[0] };
}

it("Ctrl+Enter and Meta+Enter create; a plain Enter key does not", () => {
  const m = mount();
  m.typeName("birch");
  m.keydown({ key: "Enter" });
  expect(m.onCreate).not.toHaveBeenCalled();
  m.keydown({ key: "Enter", ctrlKey: true });
  expect(m.onCreate).toHaveBeenCalledTimes(1);
  m.keydown({ key: "Enter", metaKey: true });
  expect(m.onCreate).toHaveBeenCalledTimes(2);
});

it("sparse lines go in request.sparse; a bad line turns Create off", () => {
  const m = mount();
  m.typeName("birch");
  m.setSparse("apps/desktop\n\nsrc\\lib/\n");
  expect(m.create().props.disabled).toBe(false);
  m.submit();
  expect(m.onCreate.mock.calls[0][4]).toEqual({ existing: null, sparse: ["apps/desktop", "src/lib"] });
  m.setSparse("../escape");
  expect(m.create().props.disabled).toBe(true);
  m.submit();
  expect(m.onCreate).toHaveBeenCalledTimes(1);
});

it("Create more keeps the dialog open and clears the name and note", () => {
  const m = mount();
  const note = () => m.all().find((n) => n.type === "textarea" && n.props.placeholder === en("workspace.create.notePlaceholder"))!;
  m.all().find((n) => n.props.label === en("workspace.create.createMore"))!.props.onChange({ target: { checked: true } });
  m.redraw();
  m.typeName("birch");
  note().props.onChange({ target: { value: "check the footer" } });
  m.redraw();
  m.submit();
  expect(m.onCreate.mock.calls[0][5]).toBe(true);
  expect(m.onCreate.mock.calls[0][3]).toMatchObject({ note: "check the footer" });
  expect(m.onCancel).not.toHaveBeenCalled();
  m.redraw();
  expect(m.all().find((n) => n.type === "input" && n.props.autoFocus)!.props.value).toBe("");
  expect(note().props.value).toBe("");
});

it("the Branch tab lists local branches that are not checked out, and a pick sends request.existing with no base", async () => {
  const taken = DEMO_WORKSPACE.repos[0].worktrees.find((w) => w.branch !== null)!.branch!;
  const m = mount({ branches: async () => [...BRANCHES, { name: taken, remote: false }] });
  m.tab("branch");
  await flush();
  m.redraw();
  const options = nodes(m.branchSelect()!.props.children).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(options).toContain("keep-me");
  expect(options).not.toContain("origin/other");
  expect(options).not.toContain(taken);
  expect(m.create().props.disabled).toBe(true);
  m.branchSelect()!.props.onChange({ target: { value: "keep-me" } });
  m.redraw();
  expect(m.create().props.disabled).toBe(false);
  m.submit();
  const [repoId, name, from, , request] = m.onCreate.mock.calls[0];
  expect([repoId, name, from]).toEqual([m.repo.id, "keep-me", null]);
  expect(request).toEqual({ existing: "keep-me", sparse: [] });
});

it("says so when no branch is free", async () => {
  const m = mount({ branches: async () => [] });
  m.tab("branch");
  await flush();
  m.redraw();
  expect(m.branchSelect()).toBeUndefined();
  expect(m.all().some((n) => n.props.children === en("workspace.create.noBranches"))).toBe(true);
});

it("the Name tab chooses a new or an existing branch; the new one keeps the base field", async () => {
  const m = mount({ branches: async () => BRANCHES });
  const radio = () => m.all().find((n) => n.props.name === "ws-create-branch-mode")!;
  expect(radio().props.value).toBe("new");
  expect(m.branchSelect()).toBeUndefined();
  expect(m.all().some((n) => n.type === BaseRefField)).toBe(true);
  radio().props.onChange("existing");
  m.redraw();
  await flush();
  m.redraw();
  expect(m.branchSelect()).toBeDefined();
  expect(m.all().some((n) => n.type === BaseRefField)).toBe(false);
  m.branchSelect()!.props.onChange({ target: { value: "keep-me" } });
  m.redraw();
  m.typeName("birch");
  m.submit();
  expect(m.onCreate.mock.calls[0][4]).toEqual({ existing: "keep-me", sparse: [] });
  m.tab("branch");
  expect(m.all().some((n) => n.props.name === "ws-create-branch-mode")).toBe(false);
});

it("the Name tab shows the base ref field, loads the branches for it and sends the picked ref", async () => {
  const branches = vi.fn(async () => BRANCHES);
  const m = mount({ branches });
  await flush();
  m.redraw();
  expect(branches).toHaveBeenCalledWith(m.repo.path);
  const field = () => m.all().find((n) => n.type === BaseRefField)!;
  expect(field().props.branches).toEqual(BRANCHES);
  expect(field().props.failed).toBe(false);
  expect(field().props.baseRef).toBe(m.repo.baseRef);
  field().props.onChange("origin/dev");
  m.redraw();
  m.typeName("birch");
  m.submit();
  expect(m.onCreate.mock.calls[0][2]).toBe("origin/dev");
});

it("the default base ref sends null", async () => {
  const m = mount({ branches: async () => BRANCHES });
  m.typeName("birch");
  m.submit();
  expect(m.onCreate.mock.calls[0][2]).toBeNull();
});

it("a failed branch list is reported to the field, which still takes a typed ref", async () => {
  const m = mount({ branches: async () => { throw new Error("no"); } });
  await flush();
  m.redraw();
  const field = m.all().find((n) => n.type === BaseRefField)!;
  expect(field.props.failed).toBe(true);
  field.props.onChange("v1.2");
  m.redraw();
  m.typeName("birch");
  m.submit();
  expect(m.onCreate.mock.calls[0][2]).toBe("v1.2");
});

it("a preset fills the sparse folders, and Save as preset stores the typed folders for the repo", async () => {
  const api = createMockApi({});
  const repos = [{ ...structuredClone(DEMO_WORKSPACE.repos[0]), sparsePresets: [{ name: "Docs", dirs: ["docs", "apps/desktop"] }] }];
  const m = mount({ repos, api });
  const picker = () => m.all().find((n) => n.props["data-sparse-preset"])!;
  const sparse = () => m.all().find((n) => n.type === "textarea" && n.props.className === "ws-mono")!;
  const save = () => m.all().find((n) => n.props["data-sparse-save"]);
  expect(save()).toBeUndefined();
  picker().props.onChange({ target: { value: "Docs" } });
  m.redraw();
  expect(sparse().props.value).toBe("docs\napps/desktop");

  const update = vi.spyOn(api, "repoUpdate");
  m.setSparse("src\n");
  const name = () => m.all().find((n) => n.type === "input" && n.props["aria-label"] === en("workspace.create.sparsePresetName"))!;
  expect(save()!.props.disabled).toBe(true);
  name().props.onChange({ target: { value: "Source" } });
  m.redraw();
  // Enter in the name saves the preset; it does not create.
  name().props.onKeyDown({ key: "Enter", preventDefault() {} });
  await flush();
  m.redraw();
  expect(m.onCreate).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalledWith(repos[0].id, { sparsePresets: [{ name: "Docs", dirs: ["docs", "apps/desktop"] }, { name: "Source", dirs: ["src"] }] });
  expect(m.all().some((n) => n.props.role === "status" && n.props.children === en("workspace.create.sparseSaved"))).toBe(true);
  expect(picker().props.children[1].map((o: Node) => o.props.value)).toEqual(["Docs", "Source"]);
  expect(name().props.value).toBe("");
});

it("Save as preset refuses an unusable name without a call", async () => {
  const api = createMockApi({});
  const update = vi.spyOn(api, "repoUpdate");
  const m = mount({ api });
  m.setSparse("src");
  m.all().find((n) => n.type === "input" && n.props["aria-label"] === en("workspace.create.sparsePresetName"))!.props.onChange({ target: { value: "x".repeat(61) } });
  m.redraw();
  m.all().find((n) => n.props["data-sparse-save"])!.props.onClick();
  m.redraw();
  expect(update).not.toHaveBeenCalled();
  expect(m.all().some((n) => n.props.role === "alert" && n.props.children === en("workspace.create.sparseSaveBad"))).toBe(true);
});

it("warns, without blocking Create, when the new branch exists on the remote", async () => {
  vi.useFakeTimers();
  try {
    const namePreview = vi.fn(async (_repo: string, name: string) => ({ branch: name, folder: name, suffixed: false, ...(name === "taken" ? { remote: "origin/taken" } : {}) }));
    const m = mount({ namePreview });
    const warning = () => m.all().find((n) => n.props["data-remote-branch"]);
    m.typeName("taken");
    await vi.advanceTimersByTimeAsync(2000);
    m.redraw();
    expect(warning()?.props.role).toBe("status");
    expect(warning()?.props.children).toBe(translate("en", "createWorktree.preview.remote", { remote: "origin/taken" }));
    expect(m.create().props.disabled).toBe(false);
    m.typeName("free");
    await vi.advanceTimersByTimeAsync(2000);
    m.redraw();
    expect(warning()).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});

it("carries a preset status into the create extras and leaves the key out without one", () => {
  expect(buildCreate({ ...BLANK, status: "in-progress" })?.extra.status).toBe("in-progress");
  expect(buildCreate(BLANK)?.extra).not.toHaveProperty("status");
  expect(buildCreate({ ...BLANK, status: null })?.extra).not.toHaveProperty("status");
});

it("says where the worktree starts only when a status is preset", () => {
  const repos = DEMO_WORKSPACE.repos;
  const line = (status?: "todo") =>
    nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, status, onCreate: vi.fn(), onCancel: vi.fn() })).find((n) => n.props["data-starts"] !== undefined);
  expect(line("todo")?.props.children).toBe("Starts in To do");
  expect(line()).toBeUndefined();
});
