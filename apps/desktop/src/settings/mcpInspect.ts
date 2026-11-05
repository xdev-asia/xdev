import { toApiError, type Api } from "@/api";

/** The repo files that can hold MCP servers, in the order they are shown. */
export const MCP_FILES = [".mcp.json", ".claude/mcp.json", ".claude.json"] as const;
/** What "Add MCP config" writes. */
export const MCP_STARTER = '{\n  "mcpServers": {}\n}\n';
export const MCP_MAX_BYTES = 262_144;
export const MCP_MAX_SERVERS = 256;

/** One server as the list shows it. Env values are never kept, only how many there are. */
export type McpServerSummary = { name: string; transport: "stdio" | "http" | "unknown"; disabled: boolean; envCount: number };

export type McpInspection =
  | { status: "missing" }
  | { status: "invalid"; reason: "json" | "shape" | "too_large" }
  | { status: "valid"; servers: McpServerSummary[]; truncated: boolean };

export type McpRow = { rel: string; inspection: McpInspection | { status: "error"; code: string } };

const HTTP_TYPES = ["http", "sse", "streamable-http"];

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function summarize(name: string, raw: unknown): McpServerSummary {
  const s = isObject(raw) ? raw : {};
  const transport = typeof s.command === "string" ? "stdio" : typeof s.url === "string" || (typeof s.type === "string" && HTTP_TYPES.includes(s.type)) ? "http" : "unknown";
  return { name, transport, disabled: s.disabled === true, envCount: isObject(s.env) ? Object.keys(s.env).length : 0 };
}

/** What a file's text says about MCP servers. `null` text is a missing file. */
export function inspectMcpConfig(text: string | null, size: number): McpInspection {
  if (text === null) return { status: "missing" };
  if (size > MCP_MAX_BYTES) return { status: "invalid", reason: "too_large" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { status: "invalid", reason: "json" };
  }
  const servers = isObject(data) ? data.mcpServers : undefined;
  if (!isObject(servers)) return { status: "invalid", reason: "shape" };
  const names = Object.keys(servers);
  return {
    status: "valid",
    servers: names.slice(0, MCP_MAX_SERVERS).map((name) => summarize(name, servers[name])),
    truncated: names.length > MCP_MAX_SERVERS,
  };
}

/** Reads each MCP file of a repo. A missing file is `missing`; any other failure is an `error` row. */
export async function readMcpConfigs(api: Pick<Api, "fileRead">, repoPath: string): Promise<McpRow[]> {
  return Promise.all(
    MCP_FILES.map(async (rel): Promise<McpRow> => {
      try {
        const file = await api.fileRead(repoPath, rel);
        if (file.text === null) {
          // Too large to load, or binary.
          return { rel, inspection: { status: "invalid", reason: file.size > MCP_MAX_BYTES ? "too_large" : "shape" } };
        }
        return { rel, inspection: inspectMcpConfig(file.text, file.size) };
      } catch (e) {
        const code = toApiError(e).code;
        return { rel, inspection: code === "not_found" ? { status: "missing" } : { status: "error", code } };
      }
    }),
  );
}
