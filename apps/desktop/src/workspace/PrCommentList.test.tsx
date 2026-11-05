import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type PrComment } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { translate } from "@/i18n";
import { PrComments, type CommentView } from "./PrCommentList";
import { PrCommentStore } from "./prCommentStore";
import { isSendKey, type Audience } from "./prComments";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const PATH = "/demo/wt/xdev-oak";
const NOW = Date.parse("2026-11-05T12:00:00Z");

let next = 1;
function c(over: Partial<PrComment> = {}): PrComment {
  const id = next++;
  return {
    id,
    nodeId: `N${id}`,
    kind: "conversation",
    author: "maya",
    authorBot: false,
    body: `body ${id}`,
    createdAt: `2026-11-02T10:00:${String(id).padStart(2, "0")}Z`,
    url: `https://x/${id}`,
    path: null,
    line: null,
    startLine: null,
    threadId: null,
    replyTo: null,
    resolved: false,
    outdated: false,
    diffHunk: null,
    reactions: [],
    ...over,
  };
}

const LIST = [
  c({ kind: "thread", threadId: "T1", path: "src/a.rs", line: 10, startLine: 5, body: "Open one", reactions: [{ content: "HEART", count: 2, mine: true }] }),
  c({ kind: "thread", threadId: "T2", resolved: true, path: "src/b.rs", line: 3, body: "Done one" }),
  c({ author: "sam", body: "Talk" }),
  c({ author: "coderabbitai", authorBot: true, kind: "review", body: "Bot review" }),
];

async function render(opts: { list?: PrComment[]; view?: CommentView; audience?: Audience; overrides?: string[]; truncated?: boolean } = {}) {
  const base = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [PATH]: { number: 7, url: "u", state: "open", title: "t", base: "main", head: "oak" } }, prComments: { [PATH]: opts.list ?? LIST } } });
  const api = opts.truncated ? { ...base, worktreePrComments: async () => ({ comments: opts.list ?? LIST, truncated: true }) } : base;
  const store = new PrCommentStore(api);
  await store.load(PATH, 7);
  return renderToStaticMarkup(
    <PrComments store={store} worktree={PATH} number={7} overrides={opts.overrides ?? []} initialView={opts.view} initialAudience={opts.audience} now={NOW} onMarkBot={() => {}} />,
  );
}

it("shows the header with the count and the groups", async () => {
  const html = await render();
  expect(html).toContain(en("prc.title", { count: 4 }));
  expect(html).toContain(en("prc.group.needs"));
  expect(html).toContain(en("prc.group.conversation"));
  expect(html).toContain(en("prc.group.resolved"));
  expect(html).toContain("Open one");
  expect(html).toContain("a.rs:L5-L10");
});

it("lists a timeline without group headers", async () => {
  const html = await render({ view: "timeline" });
  expect(html).not.toContain(en("prc.group.needs"));
  expect(html.indexOf("Open one")).toBeLessThan(html.indexOf("Bot review"));
});

it("filters by audience and counts each chip", async () => {
  const bots = await render({ audience: "bots" });
  expect(bots).toContain("Bot review");
  expect(bots).not.toContain("Open one");
  const humans = await render({ audience: "humans" });
  expect(humans).toContain("Talk");
  expect(humans).not.toContain("Bot review");
  expect(humans).toMatch(/task-chip-count">3</);
  expect(humans).toMatch(/task-chip-count">1</);
});

it("says what is empty", async () => {
  expect(await render({ list: [] })).toContain(en("prc.empty.all"));
  expect(await render({ list: [c({ author: "sam" })], audience: "bots" })).toContain(en("prc.empty.bots"));
  expect(await render({ list: [c({ author: "dependabot[bot]" })], audience: "humans" })).toContain(en("prc.empty.humans"));
});

it("starts a conversation when there are none, else adds a comment", async () => {
  expect(await render({ list: [] })).toContain(en("prc.compose.start"));
  expect(await render()).toContain(en("prc.compose.add"));
});

it("says when GitHub gave only the first 100", async () => {
  expect(await render({ truncated: true })).toContain(en("prc.truncated", { count: 100 }));
  expect(await render()).not.toContain(en("prc.truncated", { count: 100 }));
});

it("offers the bot menu only where it applies", async () => {
  const more = en("prc.more");
  const people = await render({ list: [c({ author: "sam" })] });
  expect(people).toContain(`aria-label="${more}"`);
  const flagged = await render({ list: [c({ author: "coderabbitai" })] });
  expect(flagged).not.toContain(`aria-label="${more}"`);
  const overridden = await render({ list: [c({ author: "sam" })], overrides: ["sam"] });
  expect(overridden).toContain(`aria-label="${more}"`);
});

it("offers resolve on thread roots only, and unresolve on a resolved one", async () => {
  const html = await render({ view: "timeline" });
  expect(html.match(/data-resolve=/g)).toHaveLength(2);
  expect(html).toContain(en("prc.unresolve"));
});

it("marks a reaction as pressed and shows its count", async () => {
  const html = await render();
  expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Heart"|aria-label="Heart"[^>]*aria-pressed="true"/);
  expect(html).toContain('x-reaction-count">2<');
});

it("sends on Ctrl+Enter and Cmd+Enter, never during IME composition", () => {
  expect(isSendKey({ key: "Enter", ctrlKey: true, metaKey: false })).toBe(true);
  expect(isSendKey({ key: "Enter", ctrlKey: false, metaKey: true })).toBe(true);
  expect(isSendKey({ key: "Enter", ctrlKey: false, metaKey: false })).toBe(false);
  expect(isSendKey({ key: "Enter", ctrlKey: true, metaKey: false, isComposing: true })).toBe(false);
  expect(isSendKey({ key: "a", ctrlKey: true, metaKey: false })).toBe(false);
});
