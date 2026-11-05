import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { McpAddToRepo } from "./McpAddToRepo";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name);

async function open() {
  const api = createMockApi({});
  const repo = (await api.workspaceList())[0];
  const m = mount(McpAddToRepo, () => ({ api, cliPath: "/opt/xdev/xdev" }));
  await m.settle();
  await m.settle();
  return { api, m, repo };
}

const exists = async (api: ReturnType<typeof createMockApi>, path: string) => api.fileRead(path, ".mcp.json").then(() => true, () => false);

it("previews the entry and writes nothing until it is confirmed", async () => {
  const { api, m, repo } = await open();
  act(m.all(), "mcp-preview")!.props.onClick();
  const all = await m.settle();
  const code = all.find((n) => n.props.language === ".mcp.json")!;
  expect(JSON.parse(code.props.code)).toEqual({ mcpServers: { xdev: { command: "/opt/xdev/xdev", args: ["mcp"] } } });
  expect(await exists(api, repo.path)).toBe(false);
  // One primary: the confirm; the others are secondary.
  const confirm = act(all, "mcp-write")!;
  expect(confirm.props.variant).toBeUndefined();
  expect(act(all, "mcp-cancel")!.props.variant).toBe("secondary");
  confirm.props.onClick();
  await tick();
  const after = await m.settle();
  expect(await exists(api, repo.path)).toBe(true);
  expect(JSON.parse((await api.fileRead(repo.path, ".mcp.json")).text!).mcpServers.xdev.args).toEqual(["mcp"]);
  expect(textOf(after.find((n) => n.props["data-status"] === "mcp-add")!)).toBe("Added xdev to .mcp.json.");
});

it("cancel writes nothing", async () => {
  const { api, m, repo } = await open();
  act(m.all(), "mcp-preview")!.props.onClick();
  await m.settle();
  act(m.all(), "mcp-cancel")!.props.onClick();
  const all = await m.settle();
  expect(act(all, "mcp-write")).toBeUndefined();
  expect(await exists(api, repo.path)).toBe(false);
});

it("merges with the servers already in the file and keeps them", async () => {
  const { api, m, repo } = await open();
  const before = JSON.stringify({ mcpServers: { other: { command: "o", env: { K: "v" } } } });
  await api.fileWrite(repo.path, ".mcp.json", before, "lf", null);
  act(m.all(), "mcp-preview")!.props.onClick();
  const all = await m.settle();
  expect(textOf(all.find((n) => n.props["data-note"] === "merge")!)).toContain("added to the servers already in");
  act(all, "mcp-write")!.props.onClick();
  await tick();
  await m.settle();
  const out = JSON.parse((await api.fileRead(repo.path, ".mcp.json")).text!);
  expect(Object.keys(out.mcpServers).sort()).toEqual(["other", "xdev"]);
  expect(out.mcpServers.other.env).toEqual({ K: "v" });
});

it("a broken file is reported and offers no write", async () => {
  const { api, m, repo } = await open();
  await api.fileWrite(repo.path, ".mcp.json", "{oops", "lf", null);
  act(m.all(), "mcp-preview")!.props.onClick();
  const all = await m.settle();
  expect(all.find((n) => n.props["data-note"] === "invalid")!.props.role).toBe("alert");
  expect(act(all, "mcp-write")).toBeUndefined();
  expect((await api.fileRead(repo.path, ".mcp.json")).text).toBe("{oops");
});
