import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type Check, type MrDetail, type MrNote } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { Tabs } from "@xdev-asia/ui";
import { CreatePrDialog } from "./CreatePrDialog";
import { MrPanel } from "./MrPanel";
import { PrComposer } from "./PrComposer";
import { PrMergeMenu } from "./PrMergeMenu";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    const values = hooks.values;
    if (!(index in values)) values[index] = typeof initial === "function" ? initial() : initial;
    return [values[index], (value: unknown) => { values[index] = typeof value === "function" ? value(values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = { current: initial };
      return hooks.values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useCallback: (fn: any, deps: any) => (hooks.active ? fn : react.useCallback(fn, deps)),
    useMemo: (fn: any, deps: any) => (hooks.active ? fn() : react.useMemo(fn, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const JOBS: Check[] = [
  { name: "lint", bucket: "pass", workflow: "test", link: "https://gitlab.example/jobs/1" } as Check,
  { name: "unit", bucket: "fail", workflow: "test", link: "https://gitlab.example/jobs/2" } as Check,
];
const DETAIL: MrDetail = {
  summary: { iid: 12, url: "https://gitlab.example/-/merge_requests/12", state: "open", draft: false, title: "Add x", source: "oak", target: "main", author: "ada", updatedAt: "2026-11-02T10:00:00Z", fork: false },
  body: "Closes the **loop**.\n\n<script>alert(1)</script>",
  headSha: "abc1234def5678",
  pipeline: { id: 99, bucket: "fail", url: "https://gitlab.example/pipelines/99" },
};
const NOTES: MrNote[] = [
  { id: 1, author: "grace", body: "First note", createdAt: "2026-11-01T10:00:00Z" },
  { id: 2, author: "linus", body: "Second note", createdAt: "2026-11-02T10:00:00Z" },
];

function seeded(over: { detail?: MrDetail | null; notes?: MrNote[]; jobs?: Check[] } = {}): Api {
  const detail = over.detail === undefined ? DETAIL : over.detail;
  return createMockApi({}, {
    workspace: {
      ...DEMO_WORKSPACE,
      mrDetails: detail ? { [OAK]: structuredClone(detail) } : {},
      mrNotes: { [OAK]: structuredClone(over.notes ?? NOTES) },
      mrJobs: { [OAK]: structuredClone(over.jobs ?? JOBS) },
    },
  });
}

function mount(api: Api, extra: { page?: boolean; worktree?: string; onOpenPage?: () => void } = {}) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return MrPanel({ api, worktree: extra.worktree ?? OAK, visible: true, page: extra.page, onOpenPage: extra.onOpenPage }); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  for (const effect of hooks.effects.slice(before)) effect();
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()), values };
}
const button = (view: ReturnType<typeof mount>, label: string) => view.all().find((n) => n.props.children === label)!;
const primaries = (html: string) => (html.match(/class="btn(?: [^"]*)?"/g) ?? []).length;

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("without a merge request: the empty state, a create button that opens the GitLab dialog, no GitHub call", async () => {
  const api = seeded({ detail: null });
  const prDetail = vi.spyOn(api, "worktreePrDetail");
  const view = mount(api);
  await tick();
  const html = view.html();
  expect(html).toContain(en("mrPanel.none"));
  expect(primaries(html)).toBe(1);
  const empty = view.all().find((n) => n.props.title === en("mrPanel.none"))!;
  expect(empty.props.actions.props.children).toBe(en("ship.mr.create"));
  empty.props.actions.props.onClick();
  await tick();
  const dialog = view.all().find((n) => n.type === CreatePrDialog)!;
  expect(dialog.props.host).toBe("gitlab");
  expect(prDetail).not.toHaveBeenCalled();
});

it("shows the header, the description without raw HTML, the tabs and the notes oldest first", async () => {
  const view = mount(seeded());
  await tick();
  const html = view.html();
  expect(html).toContain("!12");
  expect(html).toContain("Add x");
  expect(html).toContain(en("checks.state.open"));
  expect(html).toContain("main ← oak");
  expect(html).toContain(en("prPanel.by", { author: "ada" }));
  expect(html).toContain("<strong>loop</strong>");
  expect(html).not.toContain("<script>");
  expect(html).toContain(en("prPanel.tab.conversation"));
  expect(html).toContain(en("mrPanel.tab.pipeline"));
  expect(html.indexOf("First note")).toBeGreaterThan(-1);
  expect(html.indexOf("First note")).toBeLessThan(html.indexOf("Second note"));
  const tabs = view.all().find((n) => n.type === Tabs)!;
  expect(tabs.props.items[1]).toMatchObject({ badge: 1, badgeTone: "danger" });
  expect(primaries(html)).toBe(0);
  // No "#12" style number and no pull request wording outside the tab label.
  const outside = html.replace(en("prPanel.tab.conversation"), "");
  expect(outside).not.toMatch(/#\d/);
  expect(outside.toLowerCase()).not.toContain("pull request");
});

it("posts a comment, then reads the notes again; a blank one shows its error under the box", async () => {
  const api = seeded();
  const post = vi.spyOn(api, "worktreeMrNotePost");
  const view = mount(api);
  await tick();
  const composer = () => view.all().find((n) => n.type === PrComposer)!;
  expect(await composer().props.onSubmit("Looks good")).toBe(true);
  expect(post).toHaveBeenCalledWith(OAK, 12, "Looks good");
  await tick();
  expect(view.html()).toContain("Looks good");
  expect(await composer().props.onSubmit("  ")).toBe(false);
  expect(composer().props.error).toBe(en("error.empty_comment"));
});

it("the Pipeline tab: status line, one row per job, a job opens its link", async () => {
  const api = seeded();
  const open = vi.spyOn(api, "openUrl").mockResolvedValue(undefined);
  const view = mount(api);
  await tick();
  view.all().find((n) => n.type === Tabs)!.props.onChange("pipeline");
  const html = view.html();
  expect(html).toContain(en("mrPanel.pipeline.status", { id: 99, status: en("checks.bucket.fail") }));
  expect((html.match(/<li class="ws-check"/g) ?? []).length).toBe(2);
  expect(html).toContain(en("checks.bucket.pass"));
  const links = view.all().filter((n) => n.props.className === "ws-checks-btn");
  expect(links).toHaveLength(2);
  links[1].props.onClick();
  expect(open).toHaveBeenCalledWith("https://gitlab.example/jobs/2");
  // The merge menu sits on this tab, fed by the merge request.
  const menu = view.all().find((n) => n.type === PrMergeMenu)!;
  expect(menu.props.source.words).toBe("mrReview");
  expect(menu.props.pr).toMatchObject({ number: 12, base: "main", head: "oak", state: "open" });
  expect(primaries(html)).toBe(0);
});

it("without a pipeline: the none line and no jobs call", async () => {
  const api = seeded({ detail: { ...DETAIL, pipeline: null }, jobs: [] });
  const jobs = vi.spyOn(api, "worktreeMrJobs");
  const view = mount(api);
  await tick();
  view.all().find((n) => n.type === Tabs)!.props.onChange("pipeline");
  expect(view.html()).toContain(en("mrPanel.pipeline.none"));
  expect(jobs).not.toHaveBeenCalled();
});

it("a merged merge request offers no merge button", async () => {
  const merged = { ...DETAIL, summary: { ...DETAIL.summary, state: "merged" as const } };
  const view = mount(seeded({ detail: merged }));
  await tick();
  view.all().find((n) => n.type === Tabs)!.props.onChange("pipeline");
  expect(primaries(view.html())).toBe(0);
  expect(view.all().find((n) => n.type === PrMergeMenu)!.props.pr.state).toBe("merged");
});

it("a truncated list says so", async () => {
  const api = seeded();
  vi.spyOn(api, "worktreeMrNotes").mockResolvedValue({ notes: NOTES, truncated: true });
  const view = mount(api);
  await tick();
  expect(view.html()).toContain(en("mrPanel.truncated"));
});

it("a glab failure reads as its reason with a retry that reads again", async () => {
  const api = seeded();
  let fail = true;
  const read = vi.spyOn(api, "worktreeMr").mockImplementation(async () => {
    if (fail) throw { code: "glab_auth" };
    return DETAIL.summary;
  });
  const view = mount(api);
  await tick();
  expect(view.html()).toContain(en("gitlab.reason.glab_auth"));
  fail = false;
  button(view, en("prPanel.retry")).props.onClick();
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.html()).toContain("Add x");
});

it("an answer for a worktree that is no longer shown is dropped", async () => {
  const api = seeded();
  let release: (v: typeof DETAIL.summary) => void = () => undefined;
  vi.spyOn(api, "worktreeMr").mockImplementation(() => new Promise((r) => { release = r; }));
  const view = mount(api);
  // The shell moved to another worktree before glab answered: the next draw gets a new path.
  const values = view.values;
  hooks.values = values; hooks.cursor = 0; hooks.active = true;
  try { MrPanel({ api, worktree: "/demo/wt/other", visible: true }); } finally { hooks.active = false; }
  release(DETAIL.summary);
  await tick();
  expect(view.html()).toContain(en("mrPanel.loading"));
});

it("the page lays the conversation and the pipeline side by side with the merge menu in the side column", async () => {
  const view = mount(seeded(), { page: true });
  await tick();
  const html = view.html();
  expect(html).toContain("pr-page-cols");
  expect(html).toContain(en("mrPanel.tab.pipeline"));
  expect(html).toContain("First note");
  expect(view.all().some((n) => n.type === Tabs)).toBe(false);
  expect(view.all().some((n) => n.type === PrMergeMenu)).toBe(true);
  expect(primaries(html)).toBe(0);
});

it("opens the merge request in the browser and refreshes from the header", async () => {
  const api = seeded();
  const open = vi.spyOn(api, "openUrl").mockResolvedValue(undefined);
  const read = vi.spyOn(api, "worktreeMrDetail");
  const view = mount(api);
  await tick();
  button(view, en("prPanel.openBrowser")).props.onClick();
  expect(open).toHaveBeenCalledWith(DETAIL.summary.url);
  read.mockClear();
  button(view, en("prPanel.refresh")).props.onClick();
  await tick();
  expect(read).toHaveBeenCalledTimes(1);
});
