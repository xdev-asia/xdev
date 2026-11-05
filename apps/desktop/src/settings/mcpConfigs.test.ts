import { expect, it } from "vitest";
import type { FileText } from "@/api";
import { MCP_FILES, MCP_MAX_BYTES, MCP_MAX_SERVERS, inspectMcpConfig, readMcpConfigs } from "./mcpConfigs";

const inspect = (value: unknown) => {
  const text = JSON.stringify(value);
  return inspectMcpConfig(text, text.length);
};

it("a missing file is missing", () => {
  expect(inspectMcpConfig(null, 0)).toEqual({ status: "missing" });
});

it("a file over the size limit is not parsed", () => {
  expect(inspectMcpConfig("{}", MCP_MAX_BYTES + 1)).toEqual({ status: "invalid", reason: "too_large" });
});

it("text that is not JSON is invalid json", () => {
  expect(inspectMcpConfig("{ nope", 6)).toEqual({ status: "invalid", reason: "json" });
});

it("JSON without an mcpServers object is not an MCP config", () => {
  for (const value of [{}, [], "x", null, { mcpServers: [] }, { mcpServers: "x" }]) {
    expect(inspect(value)).toEqual({ status: "invalid", reason: "shape" });
  }
});

it("tells stdio, http and unknown servers apart", () => {
  const result = inspect({
    mcpServers: {
      a: { command: "npx" },
      b: { url: "https://example.test/mcp" },
      c: { type: "sse" },
      d: { type: "streamable-http" },
      e: { type: "websocket" },
      f: {},
      g: "not an object",
    },
  });
  expect(result).toMatchObject({ status: "valid", truncated: false });
  if (result.status !== "valid") return;
  expect(result.servers.map((s) => [s.name, s.transport])).toEqual([
    ["a", "stdio"],
    ["b", "http"],
    ["c", "http"],
    ["d", "http"],
    ["e", "unknown"],
    ["f", "unknown"],
    ["g", "unknown"],
  ]);
});

it("marks disabled servers", () => {
  const result = inspect({ mcpServers: { on: { command: "x" }, off: { command: "x", disabled: true } } });
  if (result.status !== "valid") throw new Error("expected valid");
  expect(result.servers.map((s) => s.disabled)).toEqual([false, true]);
});

it("keeps the number of env vars and never their values", () => {
  const result = inspect({ mcpServers: { s: { command: "x", env: { TOKEN: "hunter2-secret", OTHER: "v" }, args: ["--key", "hunter2-secret"] } } });
  if (result.status !== "valid") throw new Error("expected valid");
  expect(result.servers[0].envCount).toBe(2);
  expect(JSON.stringify(result)).not.toContain("hunter2-secret");
  expect(JSON.stringify(result)).not.toContain("TOKEN");
});

it("lists at most the first 256 servers and says so", () => {
  const mcpServers = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`s${i}`, { command: "x" }]));
  const result = inspect({ mcpServers });
  if (result.status !== "valid") throw new Error("expected valid");
  expect(result.servers).toHaveLength(MCP_MAX_SERVERS);
  expect(result.truncated).toBe(true);
});

const file = (rel: string, text: string | null, size = text?.length ?? 0): FileText => ({ rel, text, kind: "text", size, hash: "h", eol: "lf" });

it("reads the three files: missing, found, and a failure as an error row", async () => {
  const api = {
    fileRead: async (_worktree: string, rel: string): Promise<FileText> => {
      if (rel === MCP_FILES[0]) return file(rel, '{"mcpServers":{"a":{"command":"x"}}}');
      if (rel === MCP_FILES[1]) throw { code: "not_found" };
      throw { code: "io" };
    },
  };
  const rows = await readMcpConfigs(api, "/repo");
  expect(rows.map((r) => r.rel)).toEqual([...MCP_FILES]);
  expect(rows[0].inspection).toMatchObject({ status: "valid" });
  expect(rows[1].inspection).toEqual({ status: "missing" });
  expect(rows[2].inspection).toEqual({ status: "error", code: "io" });
});

it("a file with no text is too large when it is big, otherwise not an MCP config", async () => {
  const api = {
    fileRead: async (_worktree: string, rel: string): Promise<FileText> =>
      rel === MCP_FILES[0] ? file(rel, null, MCP_MAX_BYTES + 1) : file(rel, null, 10),
  };
  const rows = await readMcpConfigs(api, "/repo");
  expect(rows[0].inspection).toEqual({ status: "invalid", reason: "too_large" });
  expect(rows[1].inspection).toEqual({ status: "invalid", reason: "shape" });
});
