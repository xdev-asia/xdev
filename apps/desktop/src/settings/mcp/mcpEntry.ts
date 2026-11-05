/** The `.mcp.json` entry for xdev, how it merges into a repo's file, and the user-scope commands. */

export const SERVER_NAME = "xdev";
export const MCP_FILE = ".mcp.json";

export type McpServerEntry = { command: string; args: string[] };

/** What agents start: `<xdev> mcp`. `cliPath` is the binary beside the app; `xdev` when it is not known. */
export function xdevEntry(cliPath: string | null): McpServerEntry {
  return { command: cliPath ?? "xdev", args: ["mcp"] };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export type MergeResult =
  | { status: "invalid" }
  // Nothing to write: the file already holds this very entry.
  | { status: "same"; text: string }
  // `existing`: the file is there; `replaces`: it had a different xdev entry.
  | { status: "write"; text: string; existing: boolean; replaces: boolean };

const sameEntry = (a: unknown, b: McpServerEntry): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * The text of `.mcp.json` once the xdev entry is in. `current` is the file's text, or null when it does
 * not exist. Every other key and server is kept as parsed; a file that is not a JSON object, or whose
 * `mcpServers` is not one, is `invalid` and never overwritten.
 */
export function mergeEntry(current: string | null, entry: McpServerEntry): MergeResult {
  let data: Record<string, unknown> = {};
  if (current !== null) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(current);
    } catch {
      return { status: "invalid" };
    }
    if (!isObject(parsed)) return { status: "invalid" };
    data = parsed;
  }
  if (data.mcpServers !== undefined && !isObject(data.mcpServers)) return { status: "invalid" };
  const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
  const had = Object.prototype.hasOwnProperty.call(servers, SERVER_NAME);
  const next = { ...data, mcpServers: { ...servers, [SERVER_NAME]: entry } };
  const text = `${JSON.stringify(next, null, 2)}\n`;
  if (had && sameEntry(servers[SERVER_NAME], entry)) return { status: "same", text: current ?? text };
  return { status: "write", text, existing: current !== null, replaces: had };
}

/** The snippet the preview leads with: only the xdev entry, as it will sit in the file. */
export function entrySnippet(entry: McpServerEntry): string {
  return JSON.stringify({ mcpServers: { [SERVER_NAME]: entry } }, null, 2);
}

export type AgentCli = "claude" | "codex" | "gemini";
export const AGENT_CLIS: readonly AgentCli[] = ["claude", "codex", "gemini"];

/** A shell word: quoted only when it holds a space or a quote. */
export function shellWord(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `"${s.replace(/(["$`\\])/g, "\\$1")}"` : s;
}

/** The command that adds xdev to an agent CLI for the whole user. It is shown and copied, never run by the app. */
export function userCommand(agent: AgentCli, cliPath: string | null): string {
  const bin = shellWord(xdevEntry(cliPath).command);
  switch (agent) {
    case "claude":
      return `claude mcp add --scope user ${SERVER_NAME} -- ${bin} mcp`;
    case "codex":
      return `codex mcp add ${SERVER_NAME} -- ${bin} mcp`;
    case "gemini":
      return `gemini mcp add --scope user ${SERVER_NAME} ${bin} mcp`;
  }
}
