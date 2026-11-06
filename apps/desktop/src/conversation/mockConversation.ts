import type { Api, ApiError, Conversation, ConversationEntry, ConversationSubagent, ConversationTool } from "@/api";

type ConversationApi = Pick<Api, "agentConversation" | "agentSubagents">;

export type MockConversation = ConversationApi & {
  /** Replaces the demo conversation of every session; `null` puts the fixture back. */
  __conversation(items: ConversationEntry[] | null): void;
  /** Puts a named demo conversation in place: `subagents` has two sub-agent runs and ends on a question. */
  __conversationFixture(name: "default" | "subagents"): void;
};

/** The Rust page bounds: default 200 items, at most 1000. */
export const CONVERSATION_LIMITS = { page: 200, max: 1000 } as const;

const MIN = 60_000;

function tool(name: string, summary: string, status: ConversationTool["status"], output: string): ConversationTool {
  return { name, summary, status, output, cut: false };
}

/** A short session with every kind: messages with Markdown and file paths, tool runs, an error and a compaction. */
export function fixtureConversation(now: number): ConversationEntry[] {
  const at = (n: number) => now - (20 - n) * MIN;
  const raw: Omit<ConversationEntry, "index">[] = [
    { kind: "user", text: "Fix the date format in `src/lib/format.ts` and check the tests", at: at(0), tool: null, marker: null },
    {
      kind: "assistant",
      text: "## Plan\n\nI will read the formatter first, then run the tests:\n\n1. Read `src/lib/format.ts`\n2. Change the pattern\n3. Run the tests",
      at: at(1),
      tool: null,
      marker: null,
    },
    { kind: "tool", text: "", at: at(2), tool: tool("Read", "src/lib/format.ts", "ok", "export function format(d: Date) {\n  return d.toISOString();\n}"), marker: null },
    { kind: "tool", text: "", at: at(3), tool: tool("Edit", "src/lib/format.ts", "ok", "The file was updated."), marker: null },
    { kind: "tool", text: "", at: at(4), tool: tool("Bash", "pnpm test -- format", "error", "FAIL src/lib/format.test.ts\n  expected 2026-11-05, got 05/11/2026"), marker: null },
    {
      kind: "assistant",
      text: "One test still fails: it expects ISO dates. The fix is in src/lib/format.ts:2 and the log is at /tmp/xdev-test.log.\n\n```ts\nexport function format(d: Date): string {\n  return d.toISOString().slice(0, 10);\n}\n```\n\nSee the [date docs](https://developer.example.dev/date) for the format.",
      at: at(5),
      tool: null,
      marker: null,
    },
    { kind: "marker", text: "", at: at(6), tool: null, marker: "compact" },
    { kind: "user", text: "Good. Also update README.md", at: at(7), tool: null, marker: null },
    { kind: "tool", text: "", at: at(8), tool: tool("Edit", "README.md", "ok", ""), marker: null },
    { kind: "assistant", text: "Done: **README.md** now shows the ISO format, and the tests pass.", at: at(9), tool: null, marker: null },
  ];
  return raw.map((item, index) => ({ ...item, index }));
}

/** A session that sent two sub-agents, one of which failed, and ends on a numbered question. */
export function fixtureSubagentConversation(now: number): { items: ConversationEntry[]; subagents: ConversationSubagent[] } {
  const at = (n: number) => now - (10 - n) * MIN;
  const none = { tool: null, marker: null };
  const items: ConversationEntry[] = [
    { index: 0, kind: "user", text: "Find why the parser fails and check the docs", at: at(0), ...none },
    { index: 1, kind: "assistant", text: "I will send two helpers.", at: at(1), ...none },
    { index: 2, kind: "tool", text: "", at: at(2), tool: tool("Task", "Find parser bugs", "ok", "One bug: parse_expr is a stub."), marker: null, subagent: "task-a" },
    { index: 3, kind: "tool", text: "", at: at(2), tool: tool("Task", "Check the docs", "error", "docs/parser.md is missing."), marker: null, subagent: "task-b" },
    {
      index: 4,
      kind: "assistant",
      text: "The parser has a stub and the docs are missing. Which fix should I make first?\n\n1. Fill in `parse_expr`\n2. Write the missing docs\n3. Both, parser first",
      at: at(4),
      ...none,
    },
  ];
  const subagents: ConversationSubagent[] = [
    {
      id: "task-a",
      index: 2,
      description: "Find parser bugs",
      agentType: "Explore",
      prompt: "Read src/parser.rs and list every bug you find.",
      status: "ok",
      result: "One bug: `parse_expr` in src/parser.rs is a stub.",
      cut: false,
      steps: [
        { index: 0, kind: "assistant", text: "Reading the parser.", at: at(2), ...none },
        { index: 1, kind: "tool", text: "", at: at(2), tool: tool("Read", "src/parser.rs", "ok", "fn parse_expr() { todo!() }"), marker: null },
        { index: 2, kind: "assistant", text: "parse_expr is a stub.", at: at(3), ...none },
      ],
      stepsTotal: 3,
      at: at(2),
    },
    {
      id: "task-b",
      index: 3,
      description: "Check the docs",
      agentType: null,
      prompt: "Check docs/parser.md against the code.",
      status: "error",
      result: "The helper stopped: docs/parser.md is missing.",
      cut: false,
      steps: [{ index: 0, kind: "tool", text: "", at: at(2), tool: tool("Grep", "parse_expr", "error", "no matches"), marker: null }],
      stepsTotal: 1,
      at: at(2),
    },
  ];
  return { items, subagents };
}

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

/** The conversation read of the demo: the same paging as Rust over a fixture, for any known session. */
export function createMockConversation(now: () => number = () => Date.now()): MockConversation {
  let custom: ConversationEntry[] | null = null;
  let runs: ConversationSubagent[] = [];
  return {
    __conversation(items) {
      custom = items;
      runs = [];
    },
    __conversationFixture(name) {
      if (name === "subagents") {
        const f = fixtureSubagentConversation(now());
        custom = f.items;
        runs = f.subagents;
      } else {
        custom = null;
        runs = [];
      }
    },
    async agentConversation(key, from, limit) {
      if (!key || key === "missing") return reject("not_found", "session");
      const all = custom ?? fixtureConversation(now());
      const size = Math.min(Math.max(limit ?? CONVERSATION_LIMITS.page, 1), CONVERSATION_LIMITS.max);
      const start = from === undefined ? Math.max(0, all.length - size) : Math.min(from, all.length);
      const end = Math.min(start + size, all.length);
      const markers = all.filter((i) => i.kind === "marker").slice(-50);
      const page: Conversation = {
        key: key.includes(":") ? key : `own-claude:${key}`,
        agent: "claude",
        model: "claude-opus-5-5",
        from: start,
        total: all.length,
        turns: all.filter((i) => i.kind === "user").length,
        items: structuredClone(all.slice(start, end)),
        markers: structuredClone(markers),
        subagents: structuredClone(runs),
      };
      return page;
    },
    async agentSubagents(session) {
      if (!session || session === "missing") return reject("not_found", "session");
      return runs.map(({ id, description, agentType, status, stepsTotal, at }) => ({ id, description, agentType, status, stepsTotal, at }));
    },
  };
}
