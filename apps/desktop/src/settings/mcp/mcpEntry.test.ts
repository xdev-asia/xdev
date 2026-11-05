import { expect, it } from "vitest";
import { AGENT_CLIS, entrySnippet, mergeEntry, shellWord, userCommand, xdevEntry } from "./mcpEntry";

const entry = xdevEntry("/opt/xdev/xdev");

it("the entry runs the bundled binary, or xdev when it is unknown", () => {
  expect(entry).toEqual({ command: "/opt/xdev/xdev", args: ["mcp"] });
  expect(xdevEntry(null).command).toBe("xdev");
  expect(JSON.parse(entrySnippet(entry))).toEqual({ mcpServers: { xdev: entry } });
});

it("a missing file becomes a new one holding only xdev", () => {
  const r = mergeEntry(null, entry);
  expect(r).toMatchObject({ status: "write", existing: false, replaces: false });
  if (r.status === "write") {
    expect(JSON.parse(r.text)).toEqual({ mcpServers: { xdev: entry } });
    expect(r.text.endsWith("}\n")).toBe(true);
  }
});

it("other servers and other keys survive a merge", () => {
  const current = JSON.stringify({ mcpServers: { other: { command: "o", env: { K: "v" } } }, extra: [1] });
  const r = mergeEntry(current, entry);
  expect(r).toMatchObject({ status: "write", existing: true, replaces: false });
  if (r.status === "write") {
    const out = JSON.parse(r.text);
    expect(out.mcpServers.other).toEqual({ command: "o", env: { K: "v" } });
    expect(out.mcpServers.xdev).toEqual(entry);
    expect(out.extra).toEqual([1]);
  }
});

it("a different xdev entry is flagged as replaced and the same one needs no write", () => {
  const old = JSON.stringify({ mcpServers: { xdev: { command: "old", args: ["mcp"] } } });
  expect(mergeEntry(old, entry)).toMatchObject({ status: "write", replaces: true });
  const same = JSON.stringify({ mcpServers: { xdev: entry } }, null, 2);
  expect(mergeEntry(same, entry)).toEqual({ status: "same", text: same });
});

it("a file that is not an object with an object mcpServers is left alone", () => {
  for (const bad of ["{oops", "[]", "3", "null", '{"mcpServers": []}', '{"mcpServers": "x"}']) {
    expect(mergeEntry(bad, entry), bad).toEqual({ status: "invalid" });
  }
  expect(mergeEntry("{}", entry).status).toBe("write");
});

it("user-scope commands are one per agent CLI and quote a path with spaces", () => {
  expect(AGENT_CLIS).toEqual(["claude", "codex", "gemini"]);
  expect(userCommand("claude", "/opt/xdev/xdev")).toBe("claude mcp add --scope user xdev -- /opt/xdev/xdev mcp");
  expect(userCommand("codex", null)).toBe("codex mcp add xdev -- xdev mcp");
  expect(userCommand("gemini", "C:\\Program Files\\xDev\\xdev.exe")).toContain('"C:\\\\Program Files\\\\xDev\\\\xdev.exe" mcp');
  expect(shellWord("a b")).toBe('"a b"');
  expect(shellWord("plain")).toBe("plain");
});
