import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, EmptyState, ListRow, StatusDot, SearchInput, Segmented } from "@xdev-asia/ui";
import { ContextMenu } from "@/ui/ContextMenu";
import { translate } from "@/i18n";
import type { Tab } from "@/workspace/sessions";
import { ActivityView, optionItems, rowItems, type ActivityViewProps } from "./ActivityPanel";
import type { FeedEntry } from "./feed";
import type { ActivityOptions } from "./options";
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
const off: ActivityOptions = { showIdle: false, groupBy: "none", filter: "all", compact: false };

function view(over: Partial<ActivityViewProps> = {}) {
  const calls = { selection: [] as { ids: string[]; anchor: string | null }[], rowMenu: [] as unknown[], close: [] as string[], read: [] as string[][], unread: [] as string[][], tab: [] as string[], query: [] as string[], options: [] as unknown[], menu: [] as unknown[], jump: [] as string[], clear: 0 };
  const sources = [{ tab: tab("a"), lastOutput: NOW - 1000 }, { tab: tab("b"), lastOutput: NOW - 60_000 }];
  const props: ActivityViewProps = {
    tab: "threads", query: "", options: off, groups: activityThreads(sources, names, "", off), anyThreads: true, feed: [], names, now: NOW, menuAt: null, rowMenu: null, selected: new Set<string>(), anchor: null,
    onTab: (v) => void calls.tab.push(v), onQuery: (v) => void calls.query.push(v), onOptions: (v) => void calls.options.push(v),
    onMenu: (v) => void calls.menu.push(v), onJump: (v) => void calls.jump.push(v), onClearFeed: () => void calls.clear++, onSelection: (sel, anchor) => void calls.selection.push({ ids: [...sel], anchor }), onRowMenu: (v) => void calls.rowMenu.push(v), onCloseTab: (v) => void calls.close.push(v), onMarkRead: (v) => void calls.read.push(v), onMarkUnread: (v) => void calls.unread.push(v), ...over,
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
  const button = of(tree, Button)[0]!;
  expect(button.props.variant).toBe("secondary");
  expect(button.props.type).toBe("button");
  button.props.onClick({ currentTarget: { getBoundingClientRect: () => ({ left: 4, bottom: 9 }) } });
  expect(calls.menu).toEqual([{ x: 4, y: 9 }]);
  const picked: unknown[] = [];
  const items = optionItems({ ...off, showIdle: true }, (o) => void picked.push(o));
  expect(items.map((i) => [i.id, i.checked])).toEqual([["showIdle", true], ["compact", false]]);
  items[0]!.run!();
  items[1]!.run!();
  expect(picked).toEqual([{ ...off, showIdle: false }, { ...off, showIdle: true, compact: true }]);
});

it("grouped threads get a heading per worktree", () => {
  const sources = [{ tab: tab("a"), lastOutput: 5 }];
  const { tree } = view({ groups: activityThreads(sources, names, "", { ...off, groupBy: "worktree" }) });
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
  const clear = of(tree, Button)[0]!;
  expect(clear.props.variant).toBe("secondary");
  clear.props.onClick();
  expect(calls.clear).toBe(1);
});

it("the toolbar has the filter and group controls that set the options", () => {
  const { calls, tree } = view({ options: { ...off, groupBy: "status", filter: "unread" } });
  const [, filter, group] = of(tree, Segmented);
  expect(filter!.props.value).toBe("unread");
  expect(filter!.props.options.map((o: { value: string }) => o.value)).toEqual(["all", "unread"]);
  expect(filter!.props.options.map((o: { label: string }) => o.label)).toEqual([en("activity.filter.all"), en("activity.filter.unread")]);
  expect(group!.props.label).toBe(en("activity.group.label"));
  expect(group!.props.value).toBe("status");
  expect(group!.props.options.map((o: { value: string }) => o.value)).toEqual(["none", "status", "worktree", "agent"]);
  filter!.props.onChange("all");
  group!.props.onChange("agent");
  expect(calls.options).toEqual([{ ...off, groupBy: "status", filter: "all" }, { ...off, groupBy: "agent", filter: "unread" }]);
});

it("Mark all read passes the visible ids, and waits for something unread", () => {
  const sources = [{ tab: tab("a", { unread: true }), lastOutput: 2 }, { tab: tab("b"), lastOutput: 1 }];
  const { calls, tree } = view({ groups: activityThreads(sources, names, "", off) });
  const button = of(tree, Button).find((b) => b.props.children === en("attention.markAllRead"))!;
  expect(button.props.variant).toBe("secondary");
  expect(button.props.disabled).toBe(false);
  button.props.onClick();
  expect(calls.read).toEqual([["a", "b"]]);
  const quiet = view();
  expect(of(quiet.tree, Button).find((b) => b.props.children === en("attention.markAllRead"))!.props.disabled).toBe(true);
});

it("the compact option sets data-density on the list", () => {
  expect(view().tree.find((n) => n.props.className === "act-list")!.props["data-density"]).toBeUndefined();
  expect(view({ options: { ...off, compact: true } }).tree.find((n) => n.props.className === "act-list")!.props["data-density"]).toBe("compact");
});

it("an unread row shows why, with a dot and a toggle that marks it read", () => {
  const sources = [{ tab: tab("a", { unread: true, unreadReason: "failed" }), lastOutput: NOW - 1000 }, { tab: tab("b"), lastOutput: NOW - 2000 }];
  const { calls, tree } = view({ groups: activityThreads(sources, names, "", off) });
  const [a, b] = of(tree, ListRow);
  expect(a!.props.meta).toMatch(new RegExp("^" + en("attention.reason.failed")));
  expect(b!.props.meta).not.toContain(en("attention.reason.failed"));
  const toggles = [a!, b!].map((r) => nodes(r.props.trailing)[0]!);
  expect(of(nodes(a!.props.leading), StatusDot)).toHaveLength(1);
  expect(of(nodes(b!.props.leading), StatusDot)).toHaveLength(0);
  expect(toggles.map((n) => n.props.children)).toEqual([en("attention.markRead"), en("attention.markUnread")]);
  toggles[0]!.props.onClick();
  toggles[1]!.props.onClick();
  expect(calls.read).toEqual([["a"]]);
  expect(calls.unread).toEqual([["b"]]);
});

it("the row menu has Jump, Mark read or unread, and Close tab", () => {
  const calls: string[] = [];
  const on = { jump: (id: string) => void calls.push("jump " + id), markRead: (ids: string[]) => void calls.push("read " + ids), markUnread: (ids: string[]) => void calls.push("unread " + ids), close: (id: string) => void calls.push("close " + id) };
  const unread = rowItems(tab("a", { unread: true }), on);
  expect(unread.map((i) => i.labelKey)).toEqual(["activity.row.jump", "attention.markRead", "", "activity.row.close"]);
  expect(rowItems(tab("a"), on)[1]!.labelKey).toBe("attention.markUnread");
  for (const item of unread) item.run?.();
  expect(calls).toEqual(["jump a", "read a", "close a"]);
});

it("a right click asks for the row menu, which opens for that tab and closes it", () => {
  const sources = [{ tab: tab("a"), lastOutput: 1 }];
  const groups = activityThreads(sources, names, "", off);
  const { calls, tree } = view({ groups });
  let prevented = 0;
  tree.find((n) => n.props.className === "act-item")!.props.onContextMenu({ preventDefault: () => void prevented++, clientX: 5, clientY: 6 });
  expect(prevented).toBe(1);
  expect(calls.rowMenu).toEqual([{ x: 5, y: 6, tabId: "a" }]);
  const open = view({ groups, rowMenu: { x: 5, y: 6, tabId: "a" } });
  const menu = of(open.tree, ContextMenu)[0]!;
  expect(menu.props.items.map((i: { id: string }) => i.id)).toEqual(["jump", "markUnread", "sep", "close"]);
  menu.props.items[3].run();
  expect(open.calls.close).toEqual(["a"]);
});

const click = (mods: Record<string, unknown>) => ({ shiftKey: false, ctrlKey: false, metaKey: false, preventDefault() {}, stopPropagation() {}, ...mods });
const three = () => ["a", "b", "c"].map((id, i) => ({ tab: tab(id), lastOutput: 9 - i }));

it("Ctrl or Cmd click toggles a row into the selection; a plain click is left to jump", () => {
  const groups = activityThreads(three(), names, "", off);
  const { calls, tree } = view({ groups, selected: new Set(["a"]), anchor: "a" });
  const items = tree.filter((n) => n.props.className === "act-item");
  items[1]!.props.onClickCapture(click({ ctrlKey: true }));
  items[0]!.props.onClickCapture(click({ metaKey: true }));
  let stopped = 0;
  items[2]!.props.onClickCapture(click({ stopPropagation: () => void stopped++ }));
  expect(stopped).toBe(0);
  expect(calls.selection).toEqual([{ ids: ["a", "b"], anchor: "b" }, { ids: [], anchor: "a" }]);
});

it("Shift click picks a range from the anchor", () => {
  const groups = activityThreads(three(), names, "", off);
  const { calls, tree } = view({ groups, anchor: "a" });
  tree.filter((n) => n.props.className === "act-item")[2]!.props.onClickCapture(click({ shiftKey: true }));
  expect(calls.selection).toEqual([{ ids: ["a", "b", "c"], anchor: "a" }]);
  const none = view({ groups });
  none.tree.filter((n) => n.props.className === "act-item")[1]!.props.onClickCapture(click({ shiftKey: true }));
  expect(none.calls.selection).toEqual([{ ids: ["b"], anchor: "b" }]);
});

it("the bulk bar counts the selection and acts on it; Escape clears it", () => {
  const groups = activityThreads(three(), names, "", off);
  const { calls, tree } = view({ groups, selected: new Set(["a", "c", "gone"]) });
  const bar = tree.find((n) => n.props.className === "act-bulk")!;
  expect(nodes(bar.props.children).find((n) => n.props.className === "act-bulk-count")!.props.children).toBe(en("activity.selected", { count: 2 }));
  const buttons = of(nodes(bar.props.children), Button);
  expect(buttons.map((b) => b.props.children)).toEqual([en("attention.markRead"), en("attention.markUnread"), en("activity.selection.clear")]);
  buttons[0]!.props.onClick();
  buttons[1]!.props.onClick();
  buttons[2]!.props.onClick();
  expect(calls.read).toEqual([["a", "c"]]);
  expect(calls.unread).toEqual([["a", "c"]]);
  expect(calls.selection).toEqual([{ ids: [], anchor: null }]);
  tree.find((n) => n.props.className === "act-panel")!.props.onKeyDown({ key: "Escape" });
  expect(calls.selection).toHaveLength(2);
  expect(view({ groups }).tree.some((n) => n.props.className === "act-bulk")).toBe(false);
});
