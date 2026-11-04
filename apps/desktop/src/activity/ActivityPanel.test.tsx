import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { EmptyState, ListRow, SearchInput, Segmented } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import type { Tab } from "@/workspace/sessions";
import { ActivityView, optionItems, type ActivityViewProps } from "./ActivityPanel";
import type { FeedEntry } from "./feed";
import { activityThreads } from "./threads";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (k: string, v?: Record<string, string | number>) => translate("en", k, v);
const NOW = 10_000_000;
const names = { "/a": { name: "oak", branch: "feat/oak" } };
const tab = (id: string, over: Partial<Tab> = {}) => ({ id, worktree: "/a", profileId: "claude", agent: true, status: "working", title: `T ${id}`, ...over }) as Tab;
const off = { showIdle: false, groupByWorktree: false };

function view(over: Partial<ActivityViewProps> = {}) {
  const calls = { tab: [] as string[], query: [] as string[], options: [] as unknown[], menu: [] as unknown[], jump: [] as string[], clear: 0 };
  const sources = [{ tab: tab("a"), lastOutput: NOW - 1000 }, { tab: tab("b"), lastOutput: NOW - 60_000 }];
  const props: ActivityViewProps = {
    tab: "threads", query: "", options: off, groups: activityThreads(sources, names, "", off), anyThreads: true, feed: [], names, now: NOW, menuAt: null,
    onTab: (v) => void calls.tab.push(v), onQuery: (v) => void calls.query.push(v), onOptions: (v) => void calls.options.push(v),
    onMenu: (v) => void calls.menu.push(v), onJump: (v) => void calls.jump.push(v), onClearFeed: () => void calls.clear++, ...over,
  };
  return { calls, tree: nodes(ActivityView(props)) };
}
const of = (tree: Node[], type: unknown) => tree.filter((n) => n.type === type);

it("Segmented switches between Threads and Feed", () => {
  const { calls, tree } = view();
  const seg = of(tree, Segmented)[0]!;
  expect(seg.props.options.map((o: { label: string }) => o.label)).toEqual([en("activity.tab.threads"), en("activity.tab.feed")]);
  expect(seg.props.value).toBe("threads");
  seg.props.onChange("feed");
  expect(calls.tab).toEqual(["feed"]);
});

it("rows list the threads and a click jumps to the tab", () => {
  const { calls, tree } = view();
  const rows = of(tree, ListRow);
  expect(rows.map((r) => r.props.title)).toEqual(["T a", "T b"]);
  rows[1]!.props.onClick();
  expect(calls.jump).toEqual(["b"]);
});

it("the search box reports the text and clears", () => {
  const { calls, tree } = view({ query: "x" });
  const search = of(tree, SearchInput)[0]!;
  search.props.onChange({ target: { value: "oak" } });
  search.props.onClear();
  expect(calls.query).toEqual(["oak", ""]);
});

it("the options button asks for the menu; its items toggle with a check", () => {
  const { calls, tree } = view();
  const button = tree.find((n) => n.props.className === "act-options")!;
  button.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 4, bottom: 9 }) } });
  expect(calls.menu).toEqual([{ x: 4, y: 9 }]);
  const picked: unknown[] = [];
  const items = optionItems({ showIdle: true, groupByWorktree: false }, (o) => void picked.push(o));
  expect(items.map((i) => [i.id, i.checked])).toEqual([["showIdle", true], ["groupByWorktree", false]]);
  items[0]!.run!();
  items[1]!.run!();
  expect(picked).toEqual([{ showIdle: false, groupByWorktree: false }, { showIdle: true, groupByWorktree: true }]);
});

it("grouped threads get a heading per worktree", () => {
  const sources = [{ tab: tab("a"), lastOutput: 5 }];
  const { tree } = view({ groups: activityThreads(sources, names, "", { ...off, groupByWorktree: true }) });
  expect(tree.find((n) => n.props.className === "act-group")!.props.children).toBe("oak");
});

it("empty states: no threads, no match, empty feed", () => {
  const none = view({ groups: [], anyThreads: false });
  expect(of(none.tree, EmptyState)[0]!.props.title).toBe(en("activity.empty.threads"));
  const nomatch = view({ groups: [], anyThreads: true, query: "zzz" });
  expect(of(nomatch.tree, EmptyState)[0]!.props.title).toBe(en("activity.empty.match"));
  const feed = view({ tab: "feed" });
  expect(of(feed.tree, EmptyState)[0]!.props.title).toBe(en("activity.empty.feed"));
});

it("the feed lists changes and a row jumps; Clear empties it", () => {
  const entry: FeedEntry = { id: 1, tabId: "a", worktree: "/a", profileId: "claude", title: "Fix footer", from: "working", to: "done", at: NOW - 1000 };
  const { calls, tree } = view({ tab: "feed", feed: [entry] });
  const row = of(tree, ListRow)[0]!;
  expect(row.props.meta).toBe("oak · " + en("ago.now"));
  expect(row.props.title).toBe(en("activity.feed.change", {
    tab: "Fix footer", from: en("workspace.tabs.status.working"), to: en("workspace.tabs.status.done") }));
  row.props.onClick();
  expect(calls.jump).toEqual(["a"]);
  tree.find((n) => n.props.className === "act-options")!.props.onClick();
  expect(calls.clear).toBe(1);
});
