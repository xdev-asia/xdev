import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type PrDetail, type PrView } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PrPanel } from "./PrPanel";
import { EditPrDialog } from "./EditPrDialog";
import { PrStore } from "./prs";

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
    useSyncExternalStore: (subscribe: any, get: any, server?: any) => (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
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
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const OAK = "/demo/wt/xdev-oak";
const PR: PrView = { number: 7, url: "https://example.test/pull/7", state: "open", title: "Fix the thing", base: "main", head: "oak" };
const DETAIL: PrDetail = {
  number: 7,
  url: PR.url,
  state: "open",
  title: "Fix the thing",
  body: "Closes the **loop**.\n\n<script>alert(1)</script>",
  author: "ada",
  base: "main",
  head: "oak",
  reviewDecision: "changes-requested",
  mergeable: "mergeable",
  mergeState: "blocked",
  reviewers: [{ login: "grace", state: "changes-requested" }, { login: "linus", state: "requested" }],
  entries: [
    { kind: "comment", author: "ada", body: "First note", at: "2026-11-01T10:00:00Z", url: null, review: null },
    { kind: "review", author: "grace", body: "Please split it", at: "2026-11-02T10:00:00Z", url: null, review: "changes-requested" },
  ],
  files: [{ path: "src/a.ts", additions: 3, deletions: 1 }, { path: "src/b.ts", additions: 0, deletions: 9 }],
  autoMerge: null,
};

function seeded(details: Record<string, PrDetail> = {}, prs: Record<string, PrView> = {}): Api {
  return createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs, prDetails: details } });
}

// Draws with its own hook values; the first draw's effects run once, as on mount.
function mount(api: Api, prs: PrStore, extra: { onOpenFile?: (rel: string) => void } = {}) {
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return PrPanel({ api, worktree: OAK, prs, visible: true, ...extra }); } finally { hooks.active = false; }
  };
  const before = hooks.effects.length;
  draw();
  for (const effect of hooks.effects.slice(before)) effect();
  return { all: () => nodes(draw()), html: () => renderToStaticMarkup(draw()) };
}
const button = (view: ReturnType<typeof mount>, label: string) => view.all().find((n) => n.props.children === label)!;

beforeEach(() => {
  hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false;
  vi.stubGlobal("window", new EventTarget());
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("shows the header, the tabs, the body without raw HTML, reviewers and the conversation in order", async () => {
  const api = seeded({ [OAK]: DETAIL }, { [OAK]: PR });
  const view = mount(api, new PrStore(api));
  await tick();
  const html = view.html();
  expect(html).toContain("#7");
  expect(html).toContain("Fix the thing");
  expect(html).toContain(en("checks.state.open"));
  expect(html).toContain("main ← oak");
  expect(html).toContain(en("prPanel.by", { author: "ada" }));
  expect(html).toContain(en("prPanel.decision.changes-requested"));
  expect(html).toContain(en("prPanel.mergeState.blocked"));
  for (const tab of ["conversation", "checks", "files"]) expect(html).toContain(en(`prPanel.tab.${tab}`));
  expect(html).toContain("<strong>loop</strong>");
  expect(html).not.toContain("<script>");
  expect(html).toContain("grace");
  expect(html).toContain(en("prPanel.verdict.requested"));
  expect(html.indexOf("First note")).toBeGreaterThan(-1);
  expect(html.indexOf("First note")).toBeLessThan(html.indexOf("Please split it"));
  expect(html).toContain(en("prPanel.openBrowser"));
  expect(html).toContain(en("prPanel.refresh"));
});

it("opens in the browser and refreshes from the header", async () => {
  const api = seeded({ [OAK]: DETAIL }, { [OAK]: PR });
  const open = vi.spyOn(api, "worktreePrOpen");
  const read = vi.spyOn(api, "worktreePrDetail");
  const view = mount(api, new PrStore(api));
  await tick();
  button(view, en("prPanel.openBrowser")).props.onClick();
  expect(open).toHaveBeenCalledWith(OAK, false);
  read.mockClear();
  button(view, en("prPanel.refresh")).props.onClick();
  expect(read).toHaveBeenCalledTimes(1);
});

it("Edit opens the edit dialog on the current title and body, and a save reads the PR again", async () => {
  const api = seeded({ [OAK]: structuredClone(DETAIL) }, { [OAK]: PR });
  const read = vi.spyOn(api, "worktreePrDetail");
  const view = mount(api, new PrStore(api));
  await tick();
  expect(view.all().some((n) => n.type === EditPrDialog)).toBe(false);
  button(view, en("prPanel.edit")).props.onClick();
  const dialog = view.all().find((n) => n.type === EditPrDialog)!;
  expect(dialog.props).toMatchObject({ number: 7, title: DETAIL.title, body: DETAIL.body });
  read.mockClear();
  await dialog.props.onSaved();
  expect(read).toHaveBeenCalledTimes(1);
  expect(view.all().some((n) => n.type === EditPrDialog)).toBe(false);
});

it("the reply goes out as a PR comment and the conversation shows it", async () => {
  const api = seeded({ [OAK]: structuredClone(DETAIL) }, { [OAK]: PR });
  const post = vi.spyOn(api, "worktreePrComment");
  const view = mount(api, new PrStore(api));
  await tick();
  const empty = view.all().find((n) => n.type === "form")!;
  expect(nodes(empty.props.children).some((n) => n.props.type === "submit" && n.props.disabled === true)).toBe(true);
  nodes(empty.props.children).find((n) => typeof n.props.onChange === "function")!.props.onChange({ target: { value: "Looks good to me" } });
  view.all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  await tick();
  expect(post).toHaveBeenCalledWith(OAK, 7, "Looks good to me");
  expect(view.html()).toContain("Looks good to me");
});

it("a failed reply shows the error with Retry", async () => {
  const api = seeded({ [OAK]: structuredClone(DETAIL) }, { [OAK]: PR });
  vi.spyOn(api, "worktreePrComment").mockRejectedValue({ code: "gh_failed", detail: "HTTP 502" });
  const view = mount(api, new PrStore(api));
  await tick();
  nodes(view.all().find((n) => n.type === "form")!.props.children).find((n) => typeof n.props.onChange === "function")!.props.onChange({ target: { value: "hi" } });
  view.all().find((n) => n.type === "form")!.props.onSubmit({ preventDefault() {} });
  await tick();
  const html = view.html();
  expect(html).toContain("HTTP 502");
  expect(html).toContain(en("prPanel.retry"));
});

it("auto-merge asks first, then enables with the default method", async () => {
  const api = seeded({ [OAK]: structuredClone(DETAIL) }, { [OAK]: PR });
  const merge = vi.spyOn(api, "worktreePrAutoMerge");
  const view = mount(api, new PrStore(api));
  await tick();
  button(view, en("prPanel.auto.enable")).props.onClick();
  expect(merge).not.toHaveBeenCalled();
  const dialog = view.all().find((n) => n.type === ConfirmDialog)!;
  expect(dialog.props.open).toBe(true);
  dialog.props.onConfirm();
  await tick();
  expect(merge).toHaveBeenCalledWith(OAK, 7, "squash");
  expect(view.html()).toContain(en("prPanel.auto.disable"));
});

it("cancelling the confirmation changes nothing, and turning auto-merge off needs no question", async () => {
  const on = { ...structuredClone(DETAIL), autoMerge: { method: "rebase" as const, enabledBy: "ada" } };
  const api = seeded({ [OAK]: on }, { [OAK]: PR });
  const merge = vi.spyOn(api, "worktreePrAutoMerge");
  const view = mount(api, new PrStore(api));
  await tick();
  expect(view.html()).toContain(en("prPanel.auto.on", { method: en("prPanel.method.rebase"), by: "ada" }));
  button(view, en("prPanel.auto.disable")).props.onClick();
  await tick();
  expect(merge).toHaveBeenCalledWith(OAK, 7, null);

  const off = seeded({ [OAK]: structuredClone(DETAIL) }, { [OAK]: PR });
  const other = vi.spyOn(off, "worktreePrAutoMerge");
  const v2 = mount(off, new PrStore(off));
  await tick();
  button(v2, en("prPanel.auto.enable")).props.onClick();
  v2.all().find((n) => n.type === ConfirmDialog)!.props.onCancel();
  await tick();
  expect(other).not.toHaveBeenCalled();
  expect(v2.all().find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
});

it("lists the changed files with counts and opens one by its path", async () => {
  const api = seeded({ [OAK]: DETAIL }, { [OAK]: PR });
  const opened: string[] = [];
  const view = mount(api, new PrStore(api), { onOpenFile: (rel) => opened.push(rel) });
  await tick();
  const tabs = view.all().find((n) => Array.isArray(n.props.items) && n.props.onChange)!;
  tabs.props.onChange("files");
  const html = view.html();
  expect(html).toContain("src/a.ts");
  expect(html).toContain("+3");
  expect(html).toContain("−9");
  view.all().find((n) => n.type === "button" && n.props.children === "src/b.ts")!.props.onClick();
  expect(opened).toEqual(["src/b.ts"]);
});

it("the checks tab embeds the checks without the PR header a second time", async () => {
  const api = seeded({ [OAK]: DETAIL }, { [OAK]: PR });
  const prs = new PrStore(api);
  const view = mount(api, prs);
  await tick();
  view.all().find((n) => Array.isArray(n.props.items) && n.props.onChange)!.props.onChange("checks");
  const html = view.html();
  expect(html).toContain("ws-checks");
  expect(html).not.toContain("ws-checks-pr");
  expect(html).not.toContain(en("prReview.merge.squash"));
});

it("no PR shows the empty state with Create pull request", async () => {
  const api = seeded();
  const view = mount(api, new PrStore(api));
  await tick();
  const html = view.html();
  expect(html).toContain(en("prPanel.none"));
  expect(html).toContain(en("prPanel.create"));
  expect(html).not.toContain(en("prPanel.tab.files"));
});

it("a gh failure shows the reason with Retry, and Retry reads again", async () => {
  const api = seeded({ [OAK]: DETAIL }, { [OAK]: PR });
  const read = vi.spyOn(api, "worktreePrDetail").mockRejectedValueOnce({ code: "gh_auth" });
  const view = mount(api, new PrStore(api));
  await tick();
  const html = view.html();
  expect(html).toContain(en("checks.reason.gh_auth"));
  button(view, en("prPanel.retry")).props.onClick();
  await tick();
  expect(read).toHaveBeenCalledTimes(2);
  expect(view.html()).toContain("Fix the thing");
});

it("holds at 360 px: the tab strip scrolls and long names cut instead of widening the panel", () => {
  const css = readFileSync(fileURLToPath(new URL("../styles/prPanel.css", import.meta.url)), "utf8");
  expect(css).toMatch(/\.pr-tabs\s*\{[^}]*overflow-x:\s*auto/);
  expect(css).toMatch(/\.pr-tabs \.kit-tabs\s*\{[^}]*flex-wrap:\s*nowrap/);
  expect(css).toMatch(/\.pr-panel\s*\{[^}]*min-width:\s*0/);
  expect(css).toMatch(/\.pr-file\s*\{[^}]*text-overflow:\s*ellipsis/);
  expect(css).toMatch(/\.pr-body\s*\{[^}]*overflow-x:\s*auto/);
  expect(css).not.toMatch(/border-left/);
});
