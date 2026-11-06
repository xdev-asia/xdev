import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import type { SessionRow } from "@/api";
import { SessionsPanel, type SessionsPanelProps } from "./SessionsPanel";
import { DEFAULT_QUERY, type AgentSessionsState } from "./store";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

// Handlers are reached by calling the component as a function, so the hooks it uses are stubbed.
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (init: unknown) => [init, () => {}],
  useRef: (init: unknown) => ({ current: init }),
  useEffect: () => {},
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const NOW = new Date(2026, 10, 4, 12).getTime();
const DAY = 86_400_000;

function row(key: string, title: string | null, last: number, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    session: { key, id: key, homeId: "local", agent: "claude", cwd: "/p/app", branch: "main", model: null, title, messages: 3, first: last, last } as unknown as SessionRow["session"],
    worktree: "/p/app",
    repo: "/p/app",
    resumable: true,
    ...extra,
  };
}

function props(rows: SessionRow[], over: Partial<SessionsPanelProps> = {}, state: Partial<AgentSessionsState> = {}): SessionsPanelProps {
  return {
    state: { query: DEFAULT_QUERY, rows, loading: false, error: null, homes: ["local"], more: false, contentSearch: false, reading: false, ...state },
    now: NOW,
    canScope: { worktree: true, repo: true },
    openTab: () => null,
    onSearch: vi.fn(),
    onScope: vi.fn(),
    onSort: vi.fn(),
    onAgent: vi.fn(),
    onHome: vi.fn(),
    onMore: vi.fn(),
    onPrimary: vi.fn(),
    onCopyId: vi.fn(),
    onGoTo: vi.fn(),
    ...over,
  };
}

const html = (p: SessionsPanelProps) => renderToStaticMarkup(<SessionsPanel {...p} />);
const primary = (p: SessionsPanelProps) => nodes(SessionsPanel(p)).find((n) => n.props.className === "as-act as-primary");

describe("SessionsPanel", () => {
  it("renders rows grouped by day, with the untitled fallback", () => {
    const markup = html(props([row("a", "Fix login", NOW - 1000), row("b", null, NOW - DAY)]));
    expect(markup).toContain(translate("en", "agentSessions.day.today"));
    expect(markup).toContain(translate("en", "agentSessions.day.yesterday"));
    expect(markup).toContain("Fix login");
    expect(markup).toContain(translate("en", "agentSessions.untitled"));
  });

  it("a row with a hit shows the snippet with the matched words marked, and no markup runs", () => {
    const markup = html(props([row("a", "Fix login", NOW, { hit: "see the <mark>parser</mark> &lt;b&gt;" })]));
    expect(markup).toContain('class="as-snippet"');
    expect(markup).toContain("<mark>parser</mark>");
    expect(markup).toContain("&lt;b&gt;");
    expect(markup).not.toContain("<b>");
  });

  it("a row without a hit has no snippet line", () => {
    expect(html(props([row("a", "Fix login", NOW)]))).not.toContain("as-snippet");
  });

  it("the placeholder says text is searched when the content search is on", () => {
    expect(html(props([], {}, { contentSearch: true }))).toContain(`placeholder="${translate("en", "sessionSearch.placeholder")}"`);
    expect(html(props([]))).toContain(`placeholder="${translate("en", "agentSessions.search.placeholder")}"`);
  });

  it("an open session offers Open instead of Resume", () => {
    const markup = html(props([row("a", "Fix login", NOW)], { openTab: () => "tab-1" }));
    expect(markup).toContain(`>${translate("en", "agentSessions.open")}<`);
    expect(markup).not.toContain(`>${translate("en", "agentSessions.resume")}<`);
  });

  it("Resume calls onPrimary with the row and no tab; an open row passes its tab", () => {
    const r = row("a", "Fix login", NOW);
    const onPrimary = vi.fn();
    primary(props([r], { onPrimary }))?.props.onClick();
    expect(onPrimary).toHaveBeenCalledWith(r, null);
    const onOpen = vi.fn();
    primary(props([r], { onPrimary: onOpen, openTab: () => "tab-1" }))?.props.onClick();
    expect(onOpen).toHaveBeenCalledWith(r, "tab-1");
  });

  it("a row that cannot be resumed does not call onPrimary and says why", () => {
    const onPrimary = vi.fn();
    const p = props([row("a", "x", NOW, { resumable: false })], { onPrimary });
    primary(p)?.props.onClick();
    expect(onPrimary).not.toHaveBeenCalled();
    expect(html(p)).toContain(translate("en", "agentSessions.notResumable"));
  });

  it("scope switch calls onScope", () => {
    const onScope = vi.fn();
    const seg = nodes(SessionsPanel(props([], { onScope }))).filter((n) => n.props.className === "as-seg");
    expect(seg).toHaveLength(3);
    seg[1]?.props.onClick();
    expect(onScope).toHaveBeenCalledWith("repo");
  });

  it("shows the empty state, and the no-match state when filtered", () => {
    expect(html(props([]))).toContain(translate("en", "agentSessions.empty"));
    const filtered = props([], {}, { query: { ...DEFAULT_QUERY, text: "zzz" } });
    expect(html(filtered)).toContain(translate("en", "agentSessions.noMatch"));
  });

  it("while a long refresh reads, the rows stay and a quiet status says so", () => {
    const reading = translate("en", "agentSessions.reading");
    expect(html(props([row("a", "Fix login", NOW)]))).not.toContain(reading);
    const markup = html(props([row("a", "Fix login", NOW)], {}, { reading: true, loading: true }));
    expect(markup).toContain(`role="status">${reading}<`);
    expect(markup).toContain("Fix login");
    const empty = html(props([], {}, { reading: true, loading: false }));
    expect(empty).toContain(reading);
    expect(empty).not.toContain(translate("en", "agentSessions.empty"));
    expect(empty).not.toContain(translate("en", "agentSessions.indexing"));
  });

  it("the home filter shows only with more than one home", () => {
    expect(html(props([]))).not.toContain(translate("en", "agentSessions.home.all"));
    expect(html(props([], {}, { homes: ["a", "b"] }))).toContain(translate("en", "agentSessions.home.all"));
  });

  it("groups by folder or agent from the view, and shows an empty group's note", () => {
    const rows = [row("a", "One", NOW), row("b", "Two", NOW, { worktree: "/p/lib", repo: "/p/lib" })];
    const folder = html(props(rows, { view: { groupBy: "folder", hideEmpty: true, history: null } }));
    expect(folder).toContain(">app<");
    expect(folder).toContain(">lib<");
    const agent = html(props(rows, { view: { groupBy: "agent", hideEmpty: false, history: null } }));
    expect(agent).toContain(translate("en", "agentSessions.agent.codex"));
    expect(agent).toContain(translate("en", "agentSessions.group.none"));
    expect(html(props(rows, { view: { groupBy: "agent", hideEmpty: true, history: null } }))).not.toContain(translate("en", "agentSessions.group.none"));
  });

  it("the history depth leaves older rows out", () => {
    const rows = [row("a", "New one", NOW), row("b", "Old one", NOW - 40 * DAY)];
    const markup = html(props(rows, { view: { groupBy: "day", hideEmpty: true, history: 30 } }));
    expect(markup).toContain("New one");
    expect(markup).not.toContain("Old one");
  });

  it("offers Most relevant only while searching", () => {
    const label = translate("en", "agentSessions.sort.relevance");
    expect(html(props([], {}))).not.toContain(label);
    const searching = { query: { ...DEFAULT_QUERY, text: "login", sort: "relevance" as const } };
    const markup = html(props([], {}, searching));
    expect(markup).toContain(label);
    expect(markup).toContain('<option value="relevance" selected="">');
    const idle = html(props([], {}, { query: { ...DEFAULT_QUERY, sort: "relevance" as const } }));
    expect(idle).not.toContain(label);
  });

  it("the toolbar menus report the choice", () => {
    const onView = vi.fn();
    const menus = nodes(SessionsPanel(props([], { onView }))).filter((n) => n.props.className === "as-select as-menu");
    expect(menus.map((m) => m.props.label)).toEqual([translate("en", "agentSessions.group.label"), translate("en", "agentSessions.history.label")]);
    const [group, history] = menus.map((m) => (m.props.items as { label?: string; checked?: boolean; onSelect?: () => void }[]).filter((i) => i.onSelect));
    expect(group?.map((i) => [i.label, i.checked])).toEqual([["Day", true], ["Folder", false], ["Agent", false], ["Hide empty groups", true]]);
    group?.[1]?.onSelect?.();
    group?.[3]?.onSelect?.();
    history?.[1]?.onSelect?.();
    history?.[3]?.onSelect?.();
    expect(onView.mock.calls).toEqual([[{ groupBy: "folder" }], [{ hideEmpty: false }], [{ history: 30 }], [{ history: null }]]);
  });

  it("each row has a More menu; Jump is in it only for an open session and runs the Open call", () => {
    const onPrimary = vi.fn();
    const onHandOff = vi.fn();
    const onCopyCommand = vi.fn();
    const r = row("a", "One", NOW);
    const items = (tab: string | null) => {
      const menu = nodes(SessionsPanel(props([r], { openTab: () => tab, onPrimary, onHandOff, onCopyCommand }))).find((n) => n.props.className === "as-menu-btn");
      return menu?.props.items as { label: string; onSelect(): void }[];
    };
    expect(items(null).map((i) => i.label)).toEqual(["Hand off…", "Copy resume command"]);
    const open = items("tab-9");
    expect(open.map((i) => i.label)).toEqual(["Jump to open pane", "Hand off…", "Copy resume command"]);
    open[0]?.onSelect();
    expect(onPrimary).toHaveBeenCalledWith(r, "tab-9");
    open[1]?.onSelect();
    expect(onHandOff).toHaveBeenCalledWith(r);
    open[2]?.onSelect();
    expect(onCopyCommand).toHaveBeenCalledWith("claude --resume a");
  });

  it("a row can start a drag unless it cannot resume; the drop zone shows only while dragging", () => {
    const rows = [row("a", "One", NOW), row("b", "Two", NOW, { resumable: false, worktree: null })];
    const main = nodes(SessionsPanel(props(rows))).filter((n) => n.props.className === "as-main");
    expect(main).toHaveLength(2);
    expect(html(props(rows))).not.toContain(translate("en", "agentSessions.drop"));
  });
});
