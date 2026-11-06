import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { ConversationContent, ConversationView, readTranscript, RunsHistory, RunsToggle, SessionStrip, startPoll, SubagentGroup } from "./ConversationView";
import { chipKind, Markdown, MarkdownContext, pathCandidates, type MarkdownEnv } from "./Markdown";
import { fixtureConversation, fixtureSubagentConversation } from "./mockConversation";
import { foldRows, mergePage } from "./model";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const NOW = Date.parse("2026-11-05T12:00:00Z");

function env(resolved: Record<string, string | null> = {}): MarkdownEnv {
  return {
    resolved: (p) => resolved[p],
    onPath: () => {},
    onLink: () => {},
    label: { open: (p) => `Open ${p}`, copy: (p) => `Copy path ${p}`, code: { copy: "Copy", copied: "Copied" } },
  };
}

const html = (el: ReactElement, e: MarkdownEnv = env()) => renderToStaticMarkup(<MarkdownContext.Provider value={e}>{el}</MarkdownContext.Provider>);

it("renders headings, lists, inline code and code blocks with a copy button", () => {
  const out = html(<Markdown text={"## Plan\n\n- one\n- two\n\n1. first\n\nUse `x()` here.\n\n```ts\nconst a = 1;\n```"} />);
  // Message headings sit under the view's own heading levels.
  expect(out).toContain('<h4 class="cv-md-h">Plan</h4>');
  expect(out).toMatch(/<ul><li>one<\/li><li>two<\/li><\/ul>/);
  expect(out).toContain("<ol><li>first</li></ol>");
  expect(out).toContain("<code>x()</code>");
  expect(out).toContain('class="connect-snippet cv-code"');
  expect(out).toContain('<span class="connect-lang">ts</span>');
  expect(out).toContain("const a = 1;");
});

it("keeps raw HTML as text and never makes a script or image request", () => {
  const out = html(<Markdown text={'<img src="x" onerror="alert(1)"> and <script>bad()</script>\n\n![logo](https://x.dev/a.png)'} />);
  expect(out).not.toContain("<img");
  expect(out).not.toContain("<script");
  expect(out).toContain("&lt;script&gt;");
  expect(out).toContain("logo");
});

it("turns links into a menu button and drops unsafe ones", () => {
  const out = html(<Markdown text={"See [the docs](https://x.dev/a) or https://y.dev and [bad](javascript:alert(1))"} />);
  expect(out).toContain('<button type="button" class="cv-link" aria-haspopup="menu" title="https://x.dev/a">the docs</button>');
  expect(out).toContain('title="https://y.dev"');
  // An unsafe target stays plain text: no button, no href.
  expect(out).not.toContain('title="javascript');
  expect(out.match(/<button/g)).toHaveLength(2);
  expect(out).not.toContain("href=");
});

it("makes file paths chips: open when the file exists, copy when it does not, plain for an unknown bare name", () => {
  const e = env({ "src/lib/format.ts": "src/lib/format.ts", "/tmp/x.log": null, "notes.txt": null, "README.md": "README.md" });
  const out = html(<Markdown text={"Fix src/lib/format.ts:12 and see /tmp/x.log, notes.txt and README.md.\n\nAlso `src/lib/format.ts`"} />, e);
  expect(out).toContain('data-kind="open" aria-label="Open src/lib/format.ts:12"');
  expect(out).toContain('data-kind="copy" aria-label="Copy path /tmp/x.log"');
  expect(out).not.toContain("notes.txt</button>");
  expect(out).toContain('aria-label="Open README.md"');
  // Inline code that is one path is a chip too.
  expect(out).toContain('aria-label="Open src/lib/format.ts"');
  expect(chipKind("a/b.ts", undefined)).toBe("copy");
  expect(chipKind("b.ts", undefined)).toBe("text");
  expect(chipKind("b.ts", "b.ts")).toBe("open");
});

it("lists path candidates once, without line numbers", () => {
  expect(pathCandidates("src/a.ts:1 and src/a.ts:9\nthen ./b/c.md")).toEqual(["src/a.ts", "./b/c.md"]);
});

it("folds the tool steps of the fixture into one row that opens to each step", () => {
  const rows = foldRows(fixtureConversation(NOW));
  const closed = html(<ConversationContent rows={rows} view="chat" agentName="Claude Code" open={new Set()} onToggle={() => {}} showTools={false} />);
  expect(closed).toContain('aria-expanded="false"');
  expect(closed).toContain("3 tool steps");
  expect(closed).toContain("1 failed");
  expect(closed).toContain("1 tool step");
  expect(closed).not.toContain('class="cv-steps"');
  expect(closed).toContain('data-role="user"');
  expect(closed).toContain('data-role="assistant"');
  expect(closed).toContain("Conversation compacted");
  const opened = html(<ConversationContent rows={rows} view="chat" agentName="Claude Code" open={new Set(["t2"])} onToggle={() => {}} showTools={false} />);
  expect(opened).toContain('aria-expanded="true"');
  expect(opened.match(/class="cv-step"/g)).toHaveLength(3);
  expect(opened).toContain("pnpm test -- format");
  expect(opened).toContain(">Failed<");
  expect(opened).toContain("expected 2026-11-05");
});

it("the reader shows user turns as headings and hides tool steps until the toggle is on", () => {
  const rows = foldRows(fixtureConversation(NOW));
  const doc = html(<ConversationContent rows={rows} view="reader" agentName="Claude Code" open={new Set()} onToggle={() => {}} showTools={false} />);
  expect(doc).toContain('<article class="cv-doc">');
  expect(doc).toContain('<h3 class="cv-doc-turn">Good. Also update README.md</h3>');
  expect(doc).not.toContain("cv-bubble");
  expect(doc).not.toContain("pnpm test -- format");
  const withTools = html(<ConversationContent rows={rows} view="reader" agentName="Claude Code" open={new Set()} onToggle={() => {}} showTools />);
  expect(withTools).toContain("pnpm test -- format");
});

it("the session strip names the agent, the model, the turns and the markers", () => {
  const page = { key: "k", agent: "claude", model: "claude-opus-5-5", from: 0, total: 3, turns: 2, items: [], markers: [{ index: 4, kind: "marker", text: "claude-sonnet-5-5", at: 0, tool: null, marker: "model" }], subagents: [] };
  const out = html(<SessionStrip data={mergePage(null, page)} agentName="Claude Code" />);
  expect(out).toContain('aria-label="Session"');
  expect(out).toContain("Claude Code");
  expect(out).toContain("claude-opus-5-5");
  expect(out).toContain("2 turns");
  expect(out).toContain("Model changed to claude-sonnet-5-5");
});

it("the pane header offers the conversation only when the tab has one", async () => {
  const { PaneChipsView } = await import("@/terminal/chips/PaneChips");
  const base = { agent: true, prefs: { quota: false, context: false, timer: false }, quota: null, usage: null, clock: undefined, narrow: false, hasNote: false, onNote: () => {}, open: false, onOpen: () => {}, said: "" };
  expect(renderToStaticMarkup(PaneChipsView({ ...base, onConversation: () => {} }))).toContain('aria-label="Conversation"');
  expect(renderToStaticMarkup(PaneChipsView(base))).not.toContain('aria-label="Conversation"');
});

it("folds each sub-agent run under its call and counts the runs in the header", () => {
  const { items, subagents } = fixtureSubagentConversation(NOW);
  const rows = foldRows(items);
  const content = (open: Set<string>) =>
    html(<ConversationContent rows={rows} view="chat" agentName="Claude Code" open={open} onToggle={() => {}} showTools={false} runs={subagents} onReply={() => {}} />);
  const closed = content(new Set());
  expect(closed.match(/data-testid="subagent-group"/g)).toHaveLength(2);
  expect(closed).toContain("Sub-agent: Find parser bugs");
  expect(closed).toContain("Sub-agent: Check the docs");
  expect(closed).toContain("3 steps");
  expect(closed).toContain("1 step");
  expect(closed.match(/aria-expanded="false"/g)).toHaveLength(2);
  expect(closed).not.toContain("cv-sub-body");
  expect(closed).not.toContain("parse_expr is a stub.");

  const opened = content(new Set(["s2"]));
  expect(opened.match(/aria-expanded="true"/g)).toHaveLength(1);
  expect(opened).toContain("Read src/parser.rs and list every bug you find.");
  expect(opened).toContain("Reading the parser.");
  expect(opened.match(/class="cv-step"/g)).toHaveLength(1);
  expect(opened).toContain("Follow up on result");
  expect(opened).toContain('data-run="task-a"');

  // The reader shows the same groups, whatever the tool switch says.
  const reader = html(<ConversationContent rows={rows} view="reader" agentName="Claude Code" open={new Set(["s3"])} onToggle={() => {}} showTools={false} runs={subagents} />);
  expect(reader.match(/data-testid="subagent-group"/g)).toHaveLength(2);
  expect(reader).toContain("The helper stopped:");
  expect(reader).toContain("no matches");
  // No reply handler, no reply button.
  expect(reader).not.toContain("Follow up on result");

  const toggle = html(<RunsToggle count={subagents.length} open={false} controls="runs" onToggle={() => {}} />);
  expect(toggle).toContain("Sub-agents");
  expect(toggle).toMatch(/>2<\/span>/);
  expect(toggle).toContain('aria-expanded="false"');
  const history = html(<RunsHistory id="runs" runs={subagents} onShow={() => {}} />);
  expect(history).toContain('aria-label="Sub-agent runs"');
  expect(history.match(/<li>/g)).toHaveLength(2);
  expect(history).toContain("Explore");
});

it("a call whose run is not listed still folds, with the step's own output", () => {
  const { items } = fixtureSubagentConversation(NOW);
  const out = html(<SubagentGroup item={items[2]!} run={null} open onToggle={() => {}} />);
  expect(out).toContain("Sub-agent: Find parser bugs");
  expect(out).toContain("One bug: parse_expr is a stub.");
  expect(out).toContain("0 steps");
});

const viewTab = { id: "t1", agentSession: "s1", status: "idle" as const, worktree: "/w" };
const viewApi = { agentConversation: async () => fixtureConversation(NOW), fileLinksResolve: async () => [], openUrl: async () => {} } as never;

it("tab mode has Show terminal and New conversation, no back or close, and no primary button", () => {
  const out = renderToStaticMarkup(<ConversationView api={viewApi} tab={viewTab} agentName="Claude" mode="tab" onBack={() => {}} onNewConversation={() => {}} />);
  expect(out).toContain('aria-label="Show terminal"');
  expect(out).toContain('aria-label="New conversation"');
  expect(out).not.toContain("Back to terminal");
  expect(out).not.toContain("Close conversation");
  expect(out).not.toContain('class="btn');
  expect(out).toContain('data-mode="tab"');
});

it("startPoll ticks only while working and a pollMs is set", () => {
  const tick = vi.fn();
  let fire = () => {};
  const stop = vi.fn();
  const every = vi.fn((fn: () => void) => {
    fire = fn;
    return stop;
  });
  startPoll(2000, true, tick, every);
  expect(every).toHaveBeenCalledWith(tick, 2000);
  fire();
  expect(tick).toHaveBeenCalledTimes(1);
  startPoll(2000, false, tick, every);
  startPoll(undefined, true, tick, every);
  expect(every).toHaveBeenCalledTimes(1);
});

it("readTranscript runs onMissing once on not_found, then reads again once", async () => {
  const missing = Object.assign(new Error("x"), { code: "not_found" });
  const read = vi.fn().mockRejectedValueOnce(missing).mockResolvedValueOnce("page");
  const onMissing = vi.fn(async () => {});
  const tried = new Set<string>();
  expect(await readTranscript(read, "s1", tried, onMissing)).toBe("page");
  expect(onMissing).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledTimes(2);
  // A second not_found for the same session is an error, with no third call.
  const again = vi.fn().mockRejectedValue(missing);
  await expect(readTranscript(again, "s1", tried, onMissing)).rejects.toBe(missing);
  expect(again).toHaveBeenCalledTimes(1);
  expect(onMissing).toHaveBeenCalledTimes(1);
});

it("readTranscript leaves other errors alone", async () => {
  const boom = new Error("boom");
  const onMissing = vi.fn();
  await expect(readTranscript(vi.fn().mockRejectedValue(boom), "s1", new Set(), onMissing)).rejects.toBe(boom);
  expect(onMissing).not.toHaveBeenCalled();
});

const linked = [{ index: 0, kind: "assistant", text: "See https://www.example.com/docs and http://x.test/a", at: 0, tool: null, marker: null }] as never;

it("chat rows show a chip per link, local only; the reader shows none", () => {
  const rows = foldRows(linked);
  const chat = html(<ConversationContent rows={rows} view="chat" agentName="Claude" open={new Set()} onToggle={() => {}} showTools={false} />);
  expect(chat).toContain('class="cv-linkchips"');
  expect(chat.match(/class="cv-linkchip"/g)).toHaveLength(2);
  expect(chat).toContain("example.com");
  expect(chat).toContain('aria-label="Link to x.test"');
  expect(chat).not.toContain("<img");
  expect(chat).not.toContain("favicon");
  const reader = html(<ConversationContent rows={rows} view="reader" agentName="Claude" open={new Set()} onToggle={() => {}} showTools={false} />);
  expect(reader).not.toContain("cv-linkchip");
});
