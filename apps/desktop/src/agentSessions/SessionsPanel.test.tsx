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
    state: { query: DEFAULT_QUERY, rows, loading: false, error: null, homes: ["local"], more: false, contentSearch: false, ...state },
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

  it("the home filter shows only with more than one home", () => {
    expect(html(props([]))).not.toContain(translate("en", "agentSessions.home.all"));
    expect(html(props([], {}, { homes: ["a", "b"] }))).toContain(translate("en", "agentSessions.home.all"));
  });
});
