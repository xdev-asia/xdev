import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type VaultView } from "@/api";
import { translate } from "@/i18n";
import { AccountsView } from "@/components/AccountsView";
import { ActivityBar } from "@/components/ActivityBar";
import { AgentContext } from "@/components/AgentContext";
import { AgentKitView } from "@/components/AgentKitView";
import { ChangesPanel } from "@/components/ChangesPanel";
import { Editor } from "@/components/Editor";
import { SearchPanel } from "@/components/SearchPanel";
import { Sidebar } from "@/components/Sidebar";
import { SquadsView } from "@/components/SquadsView";
import { StatusBar } from "@/components/StatusBar";
import { TasksView } from "@/components/TasksView";
import { TerminalView } from "@/terminal/TerminalView";
import { DocsView, type DocsHandle, type DocsSection, type DocsStatus, type DocsViewProps } from "./DocsView";

type Slot = { value: unknown; deps?: unknown[]; cleanup?: unknown };
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], cursor: 0, queue: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (init: () => Slot) => {
    const index = hooks.cursor++;
    if (!(index in hooks.slots)) hooks.slots[index] = init();
    return hooks.slots[index] as Slot;
  };
  const same = (a?: unknown[], b?: unknown[]) => !!a && !!b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
  return {
    ...react,
    useState: (initial: unknown) => {
      const s = slot(() => ({ value: typeof initial === "function" ? (initial as () => unknown)() : initial }));
      return [s.value, (v: unknown) => { s.value = typeof v === "function" ? (v as (p: unknown) => unknown)(s.value) : v; }];
    },
    useRef: (initial: unknown) => slot(() => ({ value: { current: initial } })).value,
    useMemo: (fn: () => unknown) => fn(),
    useCallback: (fn: unknown, deps: unknown[]) => {
      const s = slot(() => ({ value: fn }));
      if (!same(s.deps, deps)) { s.value = fn; s.deps = deps; }
      return s.value;
    },
    useImperativeHandle: (ref: { current: unknown } | null, create: () => unknown) => { if (ref) ref.current = create(); },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      const s = slot(() => ({ value: undefined }));
      if (same(s.deps, deps)) return;
      s.deps = deps;
      hooks.queue.push(() => {
        if (typeof s.cleanup === "function") s.cleanup();
        s.cleanup = effect();
      });
    },
  };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
vi.mock("@/keys/keymap", () => ({ useKeymap: () => undefined }));

type Node = ReactElement<Record<string, any>>;
const LOCAL = new Set(["Folder", "Bare", "Standalone"]);
/** Walks an element tree, rendering the three local components in place. */
function nodes(value: unknown, ref?: { current: DocsHandle | null }): Node[] {
  if (Array.isArray(value)) return value.flatMap((v) => nodes(v, ref));
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  const type = node.type as any;
  const render = typeof type === "function" ? type : type?.render;
  if (render && LOCAL.has(render.name)) return [node, ...nodes(render(node.props, ref ?? null), ref)];
  return [node, ...nodes(node.props.children, ref)];
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const en = (key: string) => translate("en", key);

const repo: VaultView = { id: "repo:r1", kind: "repo", path: "/p/docs", name: "p", repoId: "r1", exists: true };
const shared: VaultView = { id: "s1", kind: "shared", path: "/notes", name: "notes", repoId: null, exists: true };

async function view(over: Partial<DocsViewProps> = {}, seed: Record<string, string> = { "a.md": "# A\n", "b.md": "# B\n" }) {
  const api = createMockApi(seed);
  const handle: { current: DocsHandle | null } = { current: null };
  const status: DocsStatus[] = [];
  const props: DocsViewProps = {
    api,
    source: repo,
    section: "docs" as DocsSection,
    onStatus: (s) => status.push(s),
    onCreateDocs: vi.fn(),
    onAddShared: vi.fn(),
    ...over,
  };
  const all = () => {
    hooks.cursor = 0;
    // A fresh element each time, so a changed prop is seen; state lives in the slots.
    const out = nodes((DocsView as any).render(props, handle), handle);
    return out;
  };
  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      all();
      hooks.queue.splice(0).forEach((run) => run());
      await tick();
    }
  };
  await settle();
  const of = (type: unknown) => all().filter((n) => n.type === type);
  return { api, props, handle, status, all, of, settle };
}
beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.queue = [];
  // useChanges listens for the window regaining focus; node has no window.
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});

it("renders none of the app chrome", async () => {
  const v = await view();
  for (const chrome of [ActivityBar, StatusBar, SearchPanel, TerminalView, AccountsView]) expect(v.of(chrome)).toHaveLength(0);
  const classes = v.all().map((n) => String(n.props.className ?? ""));
  for (const name of ["topbar", "topbar-vault", "search", "statusbar", "activitybar"]) expect(classes).not.toContain(name);
});

it.each([
  ["docs", Sidebar],
  ["changes", ChangesPanel],
  ["context", AgentContext],
  ["tasks", TasksView],
  ["squads", SquadsView],
  ["kit", AgentKitView],
] as const)("the %s section renders its view", async (section, type) => {
  const v = await view({ section });
  expect(v.of(type)).toHaveLength(1);
  // The other sections' views are not there.
  for (const other of [Sidebar, ChangesPanel, AgentContext, TasksView, SquadsView, AgentKitView].filter((t) => t !== type)) {
    if (section === "kit" || other !== AgentKitView) expect(v.of(other)).toHaveLength(0);
  }
});

it("tells the shared vault from a repo's in the agent context", async () => {
  const sharedView = await view({ section: "context", source: shared });
  expect(sharedView.all().some((n) => n.props.children === en("docsview.sharedNote"))).toBe(true);
  const repoView = await view({ section: "context" });
  expect(repoView.all().some((n) => n.props.children === en("docsview.sharedNote"))).toBe(false);
});

it.each(["docs", "changes", "context"] as const)("shows the empty state for %s without a source", async (section) => {
  const v = await view({ section, source: null });
  const buttons = v.all().filter((n) => n.props.onClick && [en("docsview.empty.create"), en("docsview.empty.add")].includes(String(n.props.children)));
  expect(buttons.map((b) => b.props.children)).toEqual([en("docsview.empty.create"), en("docsview.empty.add")]);
  buttons[0].props.onClick();
  buttons[1].props.onClick();
  expect(v.props.onCreateDocs).toHaveBeenCalledTimes(1);
  expect(v.props.onAddShared).toHaveBeenCalledTimes(1);
  expect(v.of(Sidebar)).toHaveLength(0);
});

it.each([
  ["tasks", TasksView],
  ["squads", SquadsView],
  ["kit", AgentKitView],
] as const)("%s stays usable without a source", async (section, type) => {
  const v = await view({ section, source: null });
  expect(v.of(type)).toHaveLength(1);
  expect(v.all().some((n) => n.props.children === en("docsview.empty.create"))).toBe(false);
});

it("reports the doc count, then dirty and saved as the doc is edited", async () => {
  const v = await view();
  expect(v.status.at(-1)).toEqual({ dirty: false, save: "saved", docs: 2, stale: 0, changes: null });
  v.of(Sidebar)[0].props.onOpen("a.md");
  await v.settle();
  v.of(Editor)[0].props.onChange("# A\nmore\n");
  await v.settle();
  expect(v.status.at(-1)).toMatchObject({ dirty: true, save: "unsaved" });
  expect(await v.handle.current!.flush()).toBe(true);
  await v.settle();
  expect(v.status.at(-1)).toMatchObject({ dirty: false, save: "saved" });
});

it("flush resolves false while a conflict is pending", async () => {
  const v = await view();
  v.of(Sidebar)[0].props.onOpen("a.md");
  await v.settle();
  v.of(Editor)[0].props.onChange("# A\nmine\n");
  await v.settle();
  // Another program rewrites the file under the open doc.
  vi.useFakeTimers();
  try {
    await v.api.writeDoc("a.md", "# A\ntheirs\n");
    // The mock echoes the write after 300 ms, as the file watcher would; autosave waits 1 s.
    await vi.advanceTimersByTimeAsync(400);
  } finally {
    vi.useRealTimers();
  }
  await v.settle();
  expect(v.status.at(-1)).toMatchObject({ save: "conflict" });
  expect(await v.handle.current!.flush()).toBe(false);
});

it("flush resolves true when nothing is open or no source is given", async () => {
  const open = await view();
  expect(await open.handle.current!.flush()).toBe(true);
  const none = await view({ source: null, section: "tasks" });
  expect(await none.handle.current!.flush()).toBe(true);
});

it("a source that cannot be opened shows why instead of the doc list", async () => {
  const api = createMockApi({});
  api.openVault = () => Promise.reject({ code: "bad_path", message: "x" });
  const v = await view({ api });
  expect(v.of(Sidebar)).toHaveLength(0);
  expect(v.all().some((n) => n.props.role === "alert")).toBe(true);
});

it("a task prop shows that task, and the same id with a new seq remounts Tasks", async () => {
  const v = await view({ section: "tasks", task: { id: "t1", seq: 1 } });
  const first = v.of(TasksView)[0];
  expect(first.props.initial).toBe("t1");
  expect(first.key).toBe("t1:1");
  v.props.task = { id: "t1", seq: 2 };
  const again = v.of(TasksView)[0];
  expect(again.props.initial).toBe("t1");
  expect(again.key).toBe("t1:2");
  v.props.task = { id: "t1", seq: 2 };
  expect(v.of(TasksView)[0].key).toBe("t1:2");
});

it("a squad link focuses its task, and the task prop overrides it", async () => {
  const v = await view({ section: "squads" });
  const asked: string[] = [];
  v.props.onSection = (s) => asked.push(s);
  v.of(SquadsView)[0].props.onOpenTask("t9");
  v.props.section = "tasks";
  expect(v.of(TasksView)[0].key).toBe("t9:1");
  v.props.task = { id: "t2", seq: 5 };
  expect(v.of(TasksView)[0].props.initial).toBe("t2");
  expect(asked).toEqual(["tasks"]);
});

it.each([["shared source", shared, "/notes"], ["no source", null, "/p/main"]] as const)("passes the project's repo on to Tasks and Squads with a %s", async (_name, source, _x) => {
  for (const section of ["tasks", "squads"] as const) {
    const v = await view({ section, source, defaultRepo: "/p/main" });
    const type = section === "tasks" ? TasksView : SquadsView;
    expect(v.of(type)[0].props.defaultRepo).toBe("/p/main");
  }
  const none = await view({ section: "tasks", source, defaultRepo: null });
  expect(none.of(TasksView)[0].props.defaultRepo).toBeNull();
});

it("opens the folder once even when every effect runs twice, as in StrictMode", async () => {
  const api = createMockApi({ "a.md": "# A" });
  const open = vi.spyOn(api, "openVault");
  const v = await view({ api });
  expect(open).toHaveBeenCalledTimes(1);
  // A StrictMode remount: every effect's deps are forgotten, so each one runs again.
  for (const slot of hooks.slots as { deps?: unknown[] }[]) if (slot) slot.deps = undefined;
  await v.settle();
  expect(open).toHaveBeenCalledTimes(1);
  expect(v.of(Sidebar)).toHaveLength(1);
});
