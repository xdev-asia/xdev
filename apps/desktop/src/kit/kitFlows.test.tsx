import { readFileSync } from "node:fs";
import { Button } from "@xdev/ui";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type MemorySet, type Skill } from "@/api";
import { AgentKitView } from "@/components/AgentKitView";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Editor } from "@/components/Editor";
import { translate } from "@/i18n";
import { sendTarget } from "@/workspace/sendTarget";
import type { Tab } from "@/workspace/sessions";
import { KitError } from "./KitError";
import { MemoryTab, MemoryTree } from "./MemoryTab";
import { PromptsTab } from "./PromptsTab";
import { SkillTable, SkillsTab } from "./SkillsTab";
import { mount, nodes, textOf, tick, type Node } from "./testHooks";

vi.mock("react", async (original) => (await import("./testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const byAction = (all: Node[], action: string) => all.find((n) => n.props["data-action"] === action);
const byText = (all: Node[], label: string) => all.find((n) => (n.type === "button" || n.type === Button) && textOf(n) === label);
const dialog = (all: Node[], title: string) => all.find((n) => n.type === ConfirmDialog && n.props.title === title)!;
const editor = (all: Node[]) => all.find((n) => n.type === Editor)!;
const tree = (all: Node[]) => all.find((n) => n.type === MemoryTree)!;

async function openFile(api: Api, path?: string) {
  const files = (await api.kitMemory(null)).files.map((f) => f.path);
  const m = mount(MemoryTab, () => ({ api, worktree: null }));
  await m.settle();
  const first = path ?? files[0]!;
  tree(m.all()).props.onSelect(first);
  await tick();
  return { m, files, first };
}

// --- I3: nothing that acts as Enter reaches the terminal --------------------------------------

it("send types one clean line, and Use cleans the history text too", async () => {
  const sent: string[] = [];
  const api = {
    ...createMockApi({}),
    kitPromptHistory: async () => [{ agent: "claude" as const, text: "one\r\ntwo\u001b[2Jx", at: 1 }],
  } as Api;
  const m = mount(PromptsTab, () => ({ api, worktree: null, onSendToAgent: async (text: string) => (sent.push(text), true) }));
  await m.settle();
  m.all().find((n) => n.type === "textarea")!.props.onChange({ target: { value: "a\r\nb\rc\td\u001b[2Je" } });
  byText(m.all(), en("kit.prompt.send"))!.props.onClick();
  await tick();
  expect(sent).toEqual(["a b c d[2Je"]);

  byText(m.all(), en("kit.prompt.recentLoad"))!.props.onClick();
  await tick();
  byText(m.all(), en("kit.prompt.use"))!.props.onClick();
  expect(m.all().find((n) => n.type === "textarea")!.props.value).toBe("one two[2Jx");
});

// --- I5: Send goes to the tab in front ---------------------------------------------------------

const tab = (id: string, agent: boolean, status = "idle"): Tab => ({ id, agent, status, worktree: "/w", profileId: "claude" } as unknown as Tab);

it("sendTarget is the tab in front, and only when it is a live agent tab", () => {
  const tabs = [tab("a", true), tab("b", true), tab("sh", false), tab("dead", true, "exited"), tab("bad", true, "failed")];
  expect(sendTarget(tabs, "a")?.id).toBe("a");
  expect(sendTarget(tabs, "b")?.id).toBe("b");
  expect(sendTarget(tabs, "sh")).toBeNull();
  expect(sendTarget(tabs, "dead")).toBeNull();
  expect(sendTarget(tabs, "bad")).toBeNull();
  expect(sendTarget(tabs, "file:x.ts")).toBeNull();
  expect(sendTarget(tabs, null)).toBeNull();
});

it("Send is off with a tooltip while no agent tab is in front", async () => {
  const api = createMockApi({});
  const m = mount(PromptsTab, () => ({ api, worktree: null, canSend: false, onSendToAgent: async () => true }));
  await m.settle();
  m.all().find((n) => n.type === "textarea")!.props.onChange({ target: { value: "hello" } });
  const send = byText(m.all(), en("kit.prompt.send"))!;
  expect(send.props.disabled).toBe(true);
  expect(send.props.title).toBe(en("kit.prompt.noActive"));
  expect(en("kit.prompt.noActive")).toBe("Open an agent tab first");
  expect(translate("vi", "kit.prompt.noActive")).not.toBe("kit.prompt.noActive");

  const on = mount(PromptsTab, () => ({ api, worktree: null, canSend: true, onSendToAgent: async () => true }));
  await on.settle();
  on.all().find((n) => n.type === "textarea")!.props.onChange({ target: { value: "hello" } });
  expect(byText(on.all(), en("kit.prompt.send"))!.props.disabled).toBe(false);
});

// --- I2: a dirty file is not dropped, and a save is not sent twice -----------------------------

it("choosing another file while the editor is dirty asks first, and Cancel keeps the edit", async () => {
  const api = createMockApi({});
  const read = vi.spyOn(api, "kitRead");
  const { m, files, first } = await openFile(api);
  expect(files.length).toBeGreaterThan(1);
  const other = files.find((f) => f !== first)!;

  editor(m.all()).props.onChange("my edit");
  read.mockClear();
  tree(m.all()).props.onSelect(other);
  await tick();
  const ask = dialog(m.all(), en("kit.memory.discardTitle"));
  expect(ask.props.open).toBe(true);
  expect(read).not.toHaveBeenCalled();

  ask.props.onCancel();
  expect(dialog(m.all(), en("kit.memory.discardTitle")).props.open).toBe(false);
  expect(editor(m.all()).props.value).toBe("my edit");
  expect(read).not.toHaveBeenCalled();

  tree(m.all()).props.onSelect(other);
  dialog(m.all(), en("kit.memory.discardTitle")).props.onConfirm();
  await tick();
  expect(read).toHaveBeenCalledWith(other, null);
  expect(editor(m.all()).props.value).toBe((await api.kitRead(other, null)).text);
});

it("a clean editor switches files without asking", async () => {
  const api = createMockApi({});
  const { m, files, first } = await openFile(api);
  const other = files.find((f) => f !== first)!;
  tree(m.all()).props.onSelect(other);
  expect(dialog(m.all(), en("kit.memory.discardTitle")).props.open).toBe(false);
  await tick();
  expect(editor(m.all()).props.value).toBe((await api.kitRead(other, null)).text);
});

it("save ignores a call while one is in flight", async () => {
  const api = createMockApi({});
  const real = api.kitWrite.bind(api);
  let release = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const write = vi.spyOn(api, "kitWrite").mockImplementation(async (...args) => (await gate, real(...args)));
  const { m } = await openFile(api);
  editor(m.all()).props.onChange("edited");
  const save = byText(m.all(), en("kit.memory.save"))!;
  save.props.onClick();
  save.props.onClick();
  editor(m.all()).props.onSave();
  await tick();
  expect(write).toHaveBeenCalledTimes(1);
  release();
  await tick();
  expect(write).toHaveBeenCalledTimes(1);
  expect(dialog(m.all(), en("kit.memory.keepTitle")).props.open).toBe(false);
});

// --- I4: the stale-stamp flow ------------------------------------------------------------------

it("a stale stamp shows the bar; Reload takes the new text", async () => {
  const api = createMockApi({});
  const { m, first } = await openFile(api);
  const stamp = (await api.kitRead(first, null)).stamp;
  await api.kitWrite(first, "theirs", stamp, null);

  editor(m.all()).props.onChange("mine");
  byText(m.all(), en("kit.memory.save"))!.props.onClick();
  await tick();
  const bar = m.all().find((n) => n.props["data-bar"] === "changed");
  expect(bar).toBeDefined();
  expect(textOf(bar!)).toContain(en("kit.memory.changed"));

  byAction(m.all(), "reload")!.props.onClick();
  await tick();
  expect(m.all().find((n) => n.props["data-bar"] === "changed")).toBeUndefined();
  expect(editor(m.all()).props.value).toBe("theirs");
});

it("Keep mine asks a second time, then writes with the fresh stamp", async () => {
  const api = createMockApi({});
  const { m, first } = await openFile(api);
  const stamp = (await api.kitRead(first, null)).stamp;
  const fresh = await api.kitWrite(first, "theirs", stamp, null);
  const write = vi.spyOn(api, "kitWrite");

  editor(m.all()).props.onChange("mine");
  byText(m.all(), en("kit.memory.save"))!.props.onClick();
  await tick();
  expect(write).toHaveBeenLastCalledWith(first, "mine", stamp, null);

  byAction(m.all(), "keep")!.props.onClick();
  expect(dialog(m.all(), en("kit.memory.keepTitle")).props.open).toBe(true);
  expect(write).toHaveBeenCalledTimes(1);

  dialog(m.all(), en("kit.memory.keepTitle")).props.onConfirm();
  await tick();
  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(first, "mine", fresh, null);
  expect((await api.kitRead(first, null)).text).toBe("mine");
  expect(m.all().find((n) => n.props["data-bar"] === "changed")).toBeUndefined();
});

// --- I4: remove, then Undo ---------------------------------------------------------------------

it("Undo after a remove restores the skill from where it was moved", async () => {
  const api = createMockApi({});
  const remove = vi.spyOn(api, "kitSkillRemove");
  const restore = vi.spyOn(api, "kitSkillRestore");
  const m = mount(SkillsTab, () => ({ api, worktree: null }));
  await m.settle();
  const table = m.all().find((n) => n.type === SkillTable)!;
  const skill: Skill = (table.props.skills as Skill[])[0]!;

  table.props.onRemove(skill);
  const ask = dialog(m.all(), en("kit.skills.removeTitle", { name: skill.name }));
  expect(ask.props.open).toBe(true);
  expect(remove).not.toHaveBeenCalled();

  ask.props.onConfirm();
  await tick();
  expect(remove).toHaveBeenCalledWith(skill.dir, null);
  const aside = await remove.mock.results[0]!.value;
  const toast = m.all().find((n) => typeof n.props.toast?.undo === "function")!;
  expect(toast.props.toast.text).toBe(en("kit.skills.removed", { name: skill.name }));
  expect((await api.kitSkills(null)).some((s) => s.dir === skill.dir)).toBe(false);

  toast.props.toast.undo();
  await tick();
  expect(restore).toHaveBeenCalledWith(aside, skill.dir, null);
  expect((await api.kitSkills(null)).some((s) => s.dir === skill.dir)).toBe(true);
});

// --- A missing copy target is a new file (Rust answers `io`) ----------------------------------

it("the copy diff treats a missing target as a new file, whichever code says so", async () => {
  for (const code of ["io", "not_found"] as const) {
    const homes = [
      { id: "a", agent: "claude" as const, path: "/h/a", source: "own" as const },
      { id: "b", agent: "claude" as const, path: "/h/b", source: "own" as const },
    ];
    const source = "/h/a/CLAUDE.md";
    const api = {
      ...createMockApi({}),
      kitHomes: async () => homes,
      kitMemory: async () => ({
        files: [{ path: source, home_id: "a", kind: "instructions", parent: null, bytes: 4, tokens: 1, hash: "x", issues: [], differs_in: [] }],
        load_tokens: 1,
      }),
      kitRead: async (path: string) => (path === source ? { text: "text", stamp: "s" } : Promise.reject({ code })),
    } as unknown as Api;
    const { m } = await openFile(api, source);
    byAction(m.all(), "copy-other")!.props.onClick();
    await tick();
    const all = m.all();
    expect(all.find((n) => n.props.role === "alert")).toBeUndefined();
    expect(all.some((n) => textOf(n) === en("kit.memory.copyNew"))).toBe(true);
    expect(all.find((n) => n.props["data-target"] === "/h/b/CLAUDE.md")).toBeDefined();
  }
});

// --- A CRLF file opens clean and is saved with CRLF --------------------------------------------

function crlfKit(files: Record<string, string>) {
  const homes = [
    { id: "a", agent: "claude" as const, path: "/h/a", source: "own" as const },
    { id: "b", agent: "claude" as const, path: "/h/b", source: "own" as const },
  ];
  const source = "/h/a/CLAUDE.md";
  const disk = new Map(Object.entries(files));
  const api = {
    ...createMockApi({}),
    kitHomes: async () => homes,
    kitMemory: async () => ({
      files: [{ path: source, home_id: "a", kind: "instructions", parent: null, bytes: 6, tokens: 1, hash: "x", issues: [], differs_in: [] }],
      load_tokens: 1,
    }),
    kitRead: async (path: string) => (disk.has(path) ? { text: disk.get(path)!, stamp: "s" } : Promise.reject({ code: "io" })),
    kitWrite: vi.fn(async (path: string, text: string) => (disk.set(path, text), "s2")),
  } as unknown as Api;
  return { api, source, write: api.kitWrite as unknown as ReturnType<typeof vi.fn> };
}

/** What the editor does with the text it is given: its lines join with `\n`. */
function editorEcho(all: Node[]) {
  const ed = editor(all);
  ed.props.onChange(String(ed.props.value).replace(/\r\n/g, "\n"));
}

it("a CRLF file opens clean, with Copy on", async () => {
  const { api, source } = crlfKit({ "/h/a/CLAUDE.md": "a\r\nb\r\n" });
  const { m } = await openFile(api, source);
  editorEcho(m.all());
  const all = m.all();
  expect(all.some((n) => textOf(n) === en("kit.memory.dirty"))).toBe(false);
  expect(byText(all, en("kit.memory.save"))!.props.disabled).toBe(true);
  expect(byAction(all, "copy-other")!.props.disabled).toBe(false);
});

it("save, Keep mine and Copy write a CRLF file back with CRLF", async () => {
  const { api, source, write } = crlfKit({ "/h/a/CLAUDE.md": "a\r\nb\r\n", "/h/b/CLAUDE.md": "a\r\nb\r\n" });
  const { m } = await openFile(api, source);
  editorEcho(m.all());

  // The same text in the other home is the same, whatever its line ends.
  byAction(m.all(), "copy-other")!.props.onClick();
  await tick();
  expect(m.all().some((n) => textOf(n) === en("kit.memory.copySame"))).toBe(true);
  byText(m.all(), en("dialog.cancel"))!.props.onClick();

  editor(m.all()).props.onChange("a\nb\nc\n");
  byText(m.all(), en("kit.memory.save"))!.props.onClick();
  await tick();
  expect(write).toHaveBeenLastCalledWith(source, "a\r\nb\r\nc\r\n", "s", null);

  editor(m.all()).props.onChange("a\nb\nc\nd\n");
  const keep = m.all().find((n) => n.type === ConfirmDialog && n.props.title === en("kit.memory.keepTitle"))!;
  keep.props.onConfirm();
  await tick();
  expect(write).toHaveBeenLastCalledWith(source, "a\r\nb\r\nc\r\nd\r\n", "s", null);

  byAction(m.all(), "copy-other")!.props.onClick();
  await tick();
  byText(m.all(), en("kit.memory.copyGo", { count: 1 }))!.props.onClick();
  await tick();
  expect(write).toHaveBeenLastCalledWith("/h/b/CLAUDE.md", "a\r\nb\r\nc\r\nd\r\n", "s", null);
});

// --- An import outside the roots is listed, never opened ---------------------------------------

it("an unread outside import is a plain row, and picking it never reads it", async () => {
  const source = "/w/CLAUDE.md";
  const outside = String.raw`\\nonexistent-host\s\x.md`;
  const set = {
    files: [
      { path: source, home_id: null, kind: "instructions", parent: null, bytes: 20, tokens: 5, hash: "h", issues: [], differs_in: [] },
      { path: outside, home_id: null, kind: "import", parent: source, bytes: 0, tokens: 0, hash: "", issues: [], differs_in: [] },
    ],
    load_tokens: 5,
  } as unknown as MemorySet;
  const all = nodes(MemoryTree({ set, homes: [], selected: null, onSelect: () => {} }));
  expect(all.find((n) => n.type === "button" && n.props["data-file"] === outside)).toBeUndefined();
  const row = all.find((n) => n.props["data-file"] === outside)!;
  expect(row.props.onClick).toBeUndefined();
  expect(textOf(row)).toContain(en("kit.memory.outside"));
  expect(all.find((n) => n.type === "button" && n.props["data-file"] === source)).toBeDefined();
  expect(translate("vi", "kit.memory.outside")).toBe("ngoài thư mục, không mở");

  const kitRead = vi.fn(async () => ({ text: "x", stamp: "s" }));
  const api = { ...createMockApi({}), kitHomes: async () => [], kitMemory: async () => set, kitRead } as unknown as Api;
  const m = mount(MemoryTab, () => ({ api, worktree: null }));
  await m.settle();
  tree(m.all()).props.onSelect(outside);
  await tick();
  expect(kitRead).not.toHaveBeenCalled();
  expect(m.all().find((n) => n.type === Editor)).toBeUndefined();
});

// --- I1: a usage request does not remount, and is used once ------------------------------------

function kitView(request: { tab: "usage" | "skills"; seq: number } | null, handled: (seq: number) => void) {
  const api = createMockApi({});
  return mount(AgentKitView, () => ({ api, worktree: null, request, onRequestHandled: handled }));
}
const selected = (all: Node[]) => all.find((n) => n.props.role === "tab" && n.props["aria-selected"] === true)?.props["data-tab"];

it("a request shows its tab and is handed back once", async () => {
  const handled = vi.fn();
  let request: { tab: "usage" | "skills"; seq: number } | null = { tab: "usage", seq: 1 };
  const api = createMockApi({});
  const m = mount(AgentKitView, () => ({ api, worktree: null, request, onRequestHandled: handled }));
  await m.settle();
  expect(selected(m.all())).toBe("usage");
  expect(handled).toHaveBeenCalledTimes(1);
  expect(handled).toHaveBeenCalledWith(1);

  // The person moves on; the request is gone; nothing pulls them back.
  m.all().find((n) => n.props["data-tab"] === "prompts")!.props.onClick();
  request = null;
  await m.settle();
  expect(selected(m.all())).toBe("prompts");

  // A second request switches the same view, with no remount: the state of the view is kept.
  request = { tab: "usage", seq: 2 };
  await m.settle();
  expect(selected(m.all())).toBe("usage");
  expect(handled).toHaveBeenLastCalledWith(2);
  expect(handled).toHaveBeenCalledTimes(2);
});

it("a view that mounts with no request opens no tab and hands nothing back", async () => {
  const handled = vi.fn();
  const m = kitView(null, handled);
  await m.settle();
  expect(selected(m.all())).toBe("skills");
  expect(handled).not.toHaveBeenCalled();
});

it("neither host keys the Agent kit by the request, so a request never remounts it", () => {
  for (const file of ["../DocsApp.tsx", "../components/NoVaultView.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const element = source.match(/<AgentKitView[\s\S]*?\/>/)![0];
    expect(element).not.toMatch(/\bkey=/);
    expect(element).toMatch(/onRequestHandled=/);
  }
});

it("DocsApp and NoVaultView open the Kit only for a request that is still waiting", () => {
  for (const file of ["../DocsApp.tsx", "../components/NoVaultView.tsx"]) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    expect(source).not.toMatch(/kitSeq\s*>\s*0/);
    expect(source).toMatch(/props\.kit\?\.open/);
  }
});

// --- The details of an error are shown after it ------------------------------------------------

it("an error shows its detail after the message, and nothing when there is none", () => {
  const withDetail = renderToStaticMarkup(<KitError error={{ code: "kit_bad_input", detail: "the description is one line" }} />);
  expect(withDetail).toContain(en("error.kit_bad_input"));
  expect(withDetail).toContain("the description is one line");
  expect(withDetail.indexOf("the description is one line")).toBeGreaterThan(withDetail.indexOf(en("error.kit_bad_input")));
  const bare = renderToStaticMarkup(<KitError error={{ code: "kit_bad_input" }} />);
  expect(bare).toContain(en("error.kit_bad_input"));
  expect(bare).not.toContain("kit-detail");
  expect(renderToStaticMarkup(<KitError error={{ code: "kit_bad_input", detail: "" }} />)).not.toContain("kit-detail");
});

it("the Memory tab shows the detail of the error that stopped a read", async () => {
  const api = {
    ...createMockApi({}),
    kitRead: () => Promise.reject({ code: "kit_bad_input", detail: "that is not a memory file" }),
  } as Api;
  const { m } = await openFile(api);
  const bar = nodes(m.draw()).find((n) => n.type === KitError)!;
  expect(bar.props.error).toEqual({ code: "kit_bad_input", detail: "that is not a memory file" });
});
