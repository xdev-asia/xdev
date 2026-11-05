import type { Api, McpActivityView, McpToolView } from "./api";

type McpApi = Pick<Api, "mcpToolsGet" | "mcpToolSet" | "mcpActivity" | "mcpHealth">;

const tool = (name: string, sensitive: boolean): McpToolView => ({ name, sensitive, defaultOn: !sensitive, enabled: !sensitive });

/** The same tools and defaults as `xdev-mcp`'s app tools. */
const TOOLS: McpToolView[] = [
  tool("list_tabs", false),
  tool("list_worktrees", false),
  tool("list_ports", false),
  tool("read_tab_output", true),
  tool("send_to_tab", true),
  tool("create_worktree", true),
];

/** Three calls, newest first, one of them failed. */
function demoActivity(now: number): McpActivityView[] {
  return [
    { atMs: now - 60_000, tool: "list_tabs", ok: true, durationMs: 14 },
    { atMs: now - 3_600_000, tool: "list_ports", ok: false, durationMs: 2 },
    { atMs: now - 7_200_000, tool: "list_worktrees", ok: true, durationMs: 31 },
  ];
}

/** The MCP page's state in memory: switches that persist for the session, a small log and a healthy server. */
export function createMockMcp(): McpApi {
  let tools = TOOLS.map((t) => ({ ...t }));
  return {
    async mcpToolsGet() {
      return tools.map((t) => ({ ...t }));
    },
    async mcpToolSet(name, enabled) {
      if (!tools.some((t) => t.name === name)) throw Object.assign(new Error("mcp_unknown_tool"), { code: "mcp_unknown_tool" });
      tools = tools.map((t) => (t.name === name ? { ...t, enabled } : t));
      return tools.map((t) => ({ ...t }));
    },
    async mcpActivity() {
      return demoActivity(Date.now());
    },
    async mcpHealth() {
      return { path: "/Applications/xDev/xdev", version: "0.7.0", running: true };
    },
  };
}
