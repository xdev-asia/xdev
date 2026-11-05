import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import type { SessionRow } from "@/api";
import { FirstPromptCard, CLAMP_CHARS } from "./FirstPromptCard";
import { SessionsPanel, type SessionsPanelProps } from "./SessionsPanel";
import { DEFAULT_QUERY } from "./store";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

// The panel's hooks are stubbed, as in SessionsPanel.test.tsx. `seed` gives chosen useState calls a value, by call
// order in the panel: 1 = picked row, 4 = row whose first prompt is expanded.
let seed: Record<number, unknown> = {};
let call = 0;
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (init: unknown) => [seed[call++] ?? init, () => {}],
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
const t = (key: string) => translate("en", key);

function row(key: string, title: string | null, extra: Partial<SessionRow> = {}): SessionRow {
  return {
    session: { key, id: key, homeId: "local", agent: "claude", cwd: "/p/app", branch: null, model: null, title, messages: 3, first: NOW, last: NOW } as unknown as SessionRow["session"],
    worktree: "/p/app",
    repo: "/p/app",
    resumable: true,
    ...extra,
  };
}

function props(rows: SessionRow[], over: Partial<SessionsPanelProps> = {}): SessionsPanelProps {
  return {
    state: { query: DEFAULT_QUERY, rows, loading: false, error: null, homes: ["local"], more: false, contentSearch: false, reading: false },
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

const render = (p: SessionsPanelProps) => {
  call = 0;
  return renderToStaticMarkup(<SessionsPanel {...p} />);
};
const tree = (p: SessionsPanelProps) => {
  call = 0;
  return nodes(SessionsPanel(p));
};
const LONG = "word ".repeat(60).trim();

beforeEach(() => {
  seed = {};
});

describe("first prompt card", () => {
  it("shows under the picked row with the eyebrow, the text and a copy button", () => {
    seed = { 1: "a" };
    const markup = render(props([row("a", "Fix the login")]));
    expect(markup).toContain(t("agentSessions.firstPrompt.eyebrow"));
    expect(markup).toContain("Fix the login");
    expect(markup).toContain(`>${t("agentSessions.firstPrompt.copy")}<`);
    expect(markup).not.toContain(t("agentSessions.firstPrompt.more"));
  });

  it("is not shown for a row that is not picked", () => {
    expect(render(props([row("a", "Fix the login")]))).not.toContain(t("agentSessions.firstPrompt.eyebrow"));
  });

  it("is hidden when the title is empty, and so is the menu item", () => {
    seed = { 1: "a" };
    for (const title of [null, "", "   "]) {
      const p = props([row("a", title)], { onCopyFirstPrompt: vi.fn() });
      expect(render(p)).not.toContain(t("agentSessions.firstPrompt.eyebrow"));
      const menu = tree(p).find((n) => n.props.className === "as-menu-btn");
      expect((menu?.props.items as { label: string }[]).map((i) => i.label)).not.toContain(t("agentSessions.menu.copyFirstPrompt"));
    }
  });

  it("a long prompt is clamped with Show more; expanded it reads in full with Show less", () => {
    expect(LONG.length).toBeGreaterThan(CLAMP_CHARS);
    seed = { 1: "a" };
    const clamped = render(props([row("a", LONG)]));
    expect(clamped).toContain('data-clamped="true"');
    expect(clamped).toContain(`>${t("agentSessions.firstPrompt.more")}<`);
    seed = { 1: "a", 4: "a" };
    const full = render(props([row("a", LONG)]));
    expect(full).not.toContain("data-clamped");
    expect(full).toContain(`>${t("agentSessions.firstPrompt.less")}<`);
  });

  it("the card's toggle and copy buttons call back, and the copied label follows", () => {
    const onToggle = vi.fn();
    const onCopy = vi.fn();
    const card = nodes(FirstPromptCard({ text: LONG, expanded: false, copied: false, onToggle, onCopy }));
    card.find((n) => n.props.className === "as-act as-prompt-more")?.props.onClick();
    card.find((n) => n.props.className === "as-act as-prompt-copy")?.props.onClick();
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onCopy).toHaveBeenCalledOnce();
    expect(renderToStaticMarkup(<FirstPromptCard text="short" expanded={false} copied onToggle={onToggle} onCopy={onCopy} />)).toContain(`>${t("agentSessions.copied")}<`);
  });

  it("copies the trimmed text from the card and from the More menu", () => {
    seed = { 1: "a" };
    const onCopyFirstPrompt = vi.fn();
    const p = props([row("a", "  Fix the login ")], { onCopyFirstPrompt });
    const card = tree(p).find((n) => n.type === FirstPromptCard);
    card?.props.onCopy();
    expect(onCopyFirstPrompt).toHaveBeenLastCalledWith("Fix the login");
    const menu = tree(p).find((n) => n.props.className === "as-menu-btn");
    const item = (menu?.props.items as { label: string; onSelect(): void }[]).find((i) => i.label === t("agentSessions.menu.copyFirstPrompt"));
    item?.onSelect();
    expect(onCopyFirstPrompt).toHaveBeenCalledTimes(2);
    expect(onCopyFirstPrompt).toHaveBeenLastCalledWith("Fix the login");
  });
});

describe("resume destinations", () => {
  type Item = { label?: string; type?: string; disabled?: boolean; onSelect?(): void };
  const items = (p: SessionsPanelProps): Item[] => (tree(p).find((n) => n.props.className === "as-act as-resume-at")?.props.items as Item[]) ?? [];

  it("offers the three destinations and sends each through onResumeAt", () => {
    const r = row("a", "One", { worktree: "/p/lib" });
    const onResumeAt = vi.fn();
    const choices = items(props([r], { onResumeAt, current: "/p/app" })).filter((i) => i.onSelect);
    expect(choices.map((i) => [i.label, i.disabled])).toEqual([
      [t("agentSessions.resumeAt.here"), false],
      [t("agentSessions.resumeAt.session"), false],
      [t("agentSessions.resumeAt.newTab"), false],
    ]);
    for (const c of choices) c.onSelect?.();
    expect(onResumeAt.mock.calls).toEqual([[r, "here"], [r, "session"], [r, "newTab"]]);
  });

  it("disables the session's worktree, with a hint, when it is unknown or already on screen", () => {
    for (const r of [row("a", "One"), row("a", "One", { worktree: null })]) {
      const list = items(props([r], { onResumeAt: vi.fn(), current: "/p/app" }));
      const at = list.findIndex((i) => i.label === t("agentSessions.resumeAt.session"));
      expect(list[at]?.disabled).toBe(true);
      expect(list[at + 1]).toMatchObject({ type: "group", label: t("agentSessions.resumeAt.session.hint") });
    }
  });

  it("has no menu without onResumeAt, for an open session or for one that cannot resume", () => {
    expect(items(props([row("a", "One")]))).toEqual([]);
    expect(items(props([row("a", "One")], { onResumeAt: vi.fn(), openTab: () => "tab-1" }))).toEqual([]);
    expect(items(props([row("a", "One", { resumable: false })], { onResumeAt: vi.fn() }))).toEqual([]);
  });
});

describe("keyboard", () => {
  const rows = [row("a", "One"), row("b", "Two")];
  const main = (p: SessionsPanelProps) => tree(p).filter((n) => n.props.className === "as-main");

  it("Enter on a row resumes it with the default destination", () => {
    const onPrimary = vi.fn();
    const preventDefault = vi.fn();
    main(props(rows, { onPrimary }))[1]?.props.onKeyDown({ key: "Enter", preventDefault });
    expect(onPrimary).toHaveBeenCalledWith(rows[1], null);
    expect(preventDefault).toHaveBeenCalled();
  });

  it("only one row is a tab stop", () => {
    expect(main(props(rows)).map((n) => n.props.tabIndex)).toEqual([0, -1]);
  });

  it("the list handles the arrow keys, Home and End, and leaves other keys alone", () => {
    const list = tree(props(rows)).find((n) => n.props.className === "as-list");
    const li = { dataset: { key: "a" }, querySelector: vi.fn() };
    const target = { classList: { contains: (c: string) => c === "as-main" }, closest: () => li };
    for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) {
      const preventDefault = vi.fn();
      list?.props.onKeyDown({ key, target, preventDefault });
      expect(preventDefault).toHaveBeenCalled();
    }
    const other = vi.fn();
    list?.props.onKeyDown({ key: "a", target, preventDefault: other });
    expect(other).not.toHaveBeenCalled();
  });

  it("Shift+F10 and the context-menu key open the row's menu; plain F10 does not", () => {
    const list = tree(props(rows)).find((n) => n.props.className === "as-list");
    const click = vi.fn();
    const li = { dataset: { key: "a" }, querySelector: () => ({ click }) };
    const target = { classList: { contains: () => true }, closest: () => li };
    list?.props.onKeyDown({ key: "F10", shiftKey: true, target, preventDefault: vi.fn() });
    list?.props.onKeyDown({ key: "ContextMenu", shiftKey: false, target, preventDefault: vi.fn() });
    expect(click).toHaveBeenCalledTimes(2);
    list?.props.onKeyDown({ key: "F10", shiftKey: false, target, preventDefault: vi.fn() });
    expect(click).toHaveBeenCalledTimes(2);
  });
});
