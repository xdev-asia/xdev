import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { AgentContext } from "@/components/AgentContext";
import { ChangesPanel } from "@/components/ChangesPanel";
import { Editor } from "@/components/Editor";
import { Sidebar } from "@/components/Sidebar";
import { DocsNav } from "./DocsNav";
import { LanguageSwitch } from "@/components/LanguageSwitch";
import { DocsHost, type DocsHostProps, type DocsHostStatus } from "./DocsHost";
import { SearchPanel } from "./SearchPanel";
import { VaultEmpty } from "./VaultEmpty";
import type { DocsHandle } from "./types";

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
// A portal renders its children where the test can walk them.
vi.mock("react-dom", async (original) => ({ ...(await original<typeof import("react-dom")>()), createPortal: (children: unknown) => children }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
vi.mock("@/keys/keymap", () => ({ useKeymap: () => undefined }));
vi.mock("@/ui/hiddenApps", () => ({ useHiddenApps: () => [], useAppOrder: () => [] }));

type Node = ReactElement<Record<string, any>>;
const LOCAL = new Set(["DocsHost", "VaultView"]);
/** Walks an element tree, rendering the two local components in place. */
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  const type = node.type as any;
  if (typeof type === "function" && LOCAL.has(type.name)) return [node, ...nodes(type(node.props))];
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const en = (key: string) => translate("en", key);

async function host(over: Partial<DocsHostProps> = {}, seed: Record<string, string> = { "a.md": "# A\n", "b.md": "# B\n" }) {
  const api = over.api ?? createMockApi(seed);
  if (!over.api) api.lastVault = async () => "/p/handbook";
  const handle: { current: DocsHandle | null } = { current: null };
  const status: DocsHostStatus[] = [];
  const props: DocsHostProps = {
    api,
    navSlot: {} as HTMLElement,
    request: null,
    onStatus: (s) => status.push(s),
    ref: handle,
    ...over,
  };
  const all = () => {
    hooks.cursor = 0;
    return nodes(DocsHost(props));
  };
  const settle = async () => {
    for (let i = 0; i < 6; i++) {
      all();
      hooks.queue.splice(0).forEach((run) => run());
      await tick();
    }
  };
  await settle();
  const of = (type: unknown) => all().filter((n) => n.type === type);
  return { api, props, handle, status, all, of, settle };
}

function noFolderApi() {
  const api = createMockApi({});
  api.lastVault = async () => null;
  api.vaultSetup = async () => ({ prompt: false, defaultPath: "/d" });
  return api;
}

beforeEach(() => {
  hooks.slots = [];
  hooks.cursor = 0;
  hooks.queue = [];
  // useChanges listens for the window regaining focus; node has no window.
  vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {} });
});

it("says the folder is opening before the boot finishes", () => {
  hooks.cursor = 0;
  const out = nodes(DocsHost({ api: createMockApi({}), navSlot: null, request: null, onStatus() {} }));
  expect(out.some((n) => n.props.role === "status" && n.props.children === en("vault.opening"))).toBe(true);
});

it("renders no top bar, no inner bar and no status bar", async () => {
  const h = await host();
  const classes = h.all().map((n) => String(n.props.className ?? ""));
  for (const name of ["app", "topbar", "topbar-vault", "activitybar", "statusbar", "sidebar", "main"]) expect(classes).not.toContain(name);
  expect(h.of(LanguageSwitch)).toHaveLength(0);
});

it("draws the doc list into the nav slot and the doc stage beside it", async () => {
  const h = await host();
  expect(h.of(Sidebar)).toHaveLength(1);
  expect(h.all().some((n) => n.props.className === "docview")).toBe(true);
  const none = await host({ navSlot: null });
  expect(none.of(Sidebar)).toHaveLength(0);
});

it("the side list is the docs nav with every section", async () => {
  const h = await host();
  const nav = h.of(DocsNav)[0];
  expect(nav.props.sections).toEqual(["docs", "changes", "agents"]);
  expect(nav.props.section).toBe("docs");
  expect(nav.props.canChangeFolder).toBe(true);
});

it("picking a section in the nav shows it and tells the shell", async () => {
  const asked: string[] = [];
  const h = await host({ onOpenSection: (s) => asked.push(s) });
  h.of(DocsNav)[0].props.onSection("agents");
  await h.settle();
  expect(h.of(AgentContext)).toHaveLength(1);
  expect(asked).toEqual(["agents"]);
});

it("a query in the nav search shows the hits instead of the doc list", async () => {
  const h = await host();
  h.of(DocsNav)[0].props.search.onQuery("a");
  await h.settle();
  expect(h.of(Sidebar)).toHaveLength(0);
  expect(h.of(SearchPanel)).toHaveLength(1);
});

it("a request for the changes section shows the changes list", async () => {
  const h = await host();
  h.props.request = { seq: 1, section: "changes" };
  await h.settle();
  expect(h.of(ChangesPanel)).toHaveLength(1);
  expect(h.of(Sidebar)).toHaveLength(0);
});

it("a request for agents shows the agent context", async () => {
  const h = await host();
  expect(h.of(AgentContext)).toHaveLength(0);
  h.props.request = { seq: 1, section: "agents" };
  await h.settle();
  expect(h.of(AgentContext)).toHaveLength(1);
});

it("reports status after the folder opens", async () => {
  const h = await host();
  expect(h.status.at(-1)).toMatchObject({ dirty: false, save: "saved", docs: 2, stale: 0, folder: "handbook", path: "/p/handbook" });
});

it("reports the open doc and none before one is open", async () => {
  const h = await host();
  expect(h.status.at(-1)).toMatchObject({ doc: null });
  h.of(Sidebar)[0].props.onOpen("a.md");
  await h.settle();
  expect(h.status.at(-1)).toMatchObject({ doc: "a.md" });
});

it("reports no folder while none is open", async () => {
  const h = await host({ api: noFolderApi() });
  expect(h.status.at(-1)).toMatchObject({ docs: 0, changes: null, folder: null, path: null });
  expect(h.of(VaultEmpty)).toHaveLength(1);
});

it("reports dirty and saved as the doc is edited", async () => {
  const h = await host();
  h.of(Sidebar)[0].props.onOpen("a.md");
  await h.settle();
  h.of(Editor)[0].props.onChange("# A\nmore\n");
  await h.settle();
  expect(h.status.at(-1)).toMatchObject({ dirty: true, save: "unsaved" });
  expect(await h.handle.current!.flush()).toBe(true);
  await h.settle();
  expect(h.status.at(-1)).toMatchObject({ dirty: false, save: "saved" });
});

it("flush resolves false on conflict", async () => {
  const h = await host();
  h.of(Sidebar)[0].props.onOpen("a.md");
  await h.settle();
  h.of(Editor)[0].props.onChange("# A\nmine\n");
  await h.settle();
  vi.useFakeTimers();
  try {
    await h.api.writeDoc("a.md", "# A\ntheirs\n");
    // The mock echoes the write after 300 ms, as the file watcher would; autosave waits 1 s.
    await vi.advanceTimersByTimeAsync(400);
  } finally {
    vi.useRealTimers();
  }
  await h.settle();
  expect(h.status.at(-1)).toMatchObject({ save: "conflict" });
  expect(await h.handle.current!.flush()).toBe(false);
});

it("flush resolves true with nothing open or no folder", async () => {
  const open = await host();
  expect(await open.handle.current!.flush()).toBe(true);
  const none = await host({ api: noFolderApi() });
  expect(await none.handle.current!.flush()).toBe(true);
});

it("opens the folder once even when every effect runs twice, as in StrictMode", async () => {
  const api = createMockApi({ "a.md": "# A" });
  api.lastVault = async () => "/p/handbook";
  const open = vi.spyOn(api, "openVault");
  const h = await host({ api });
  expect(open).toHaveBeenCalledTimes(1);
  for (const slot of hooks.slots as { deps?: unknown[] }[]) if (slot) slot.deps = undefined;
  await h.settle();
  expect(open).toHaveBeenCalledTimes(1);
  expect(h.of(Sidebar)).toHaveLength(1);
});
