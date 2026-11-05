import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { FileText, WriteOutcome } from "@/api";
import { onOpenFile, type OpenFileRequest } from "@/files/openFile";
import { translate } from "@/i18n";
import { getToasts } from "@/workspace/toastStore";
import { McpConfigs } from "./McpConfigs";
import { MCP_STARTER } from "./mcpInspect";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useEffect: (effect: () => void | (() => void)) => { hooks.effects.push(effect); },
}));
vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children), ...nodes(node.props.actions), ...nodes(node.props.trailing)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const file = (rel: string, text: string): FileText => ({ rel, text, kind: "text", size: text.length, hash: "h", eol: "lf" });

type Files = Record<string, string>;
function setup(files: Files, write: (...args: unknown[]) => Promise<WriteOutcome> = async () => ({ type: "saved", hash: "h" })) {
  const fileWrite = vi.fn(write);
  const api = {
    fileRead: async (_worktree: string, rel: string): Promise<FileText> => {
      if (rel in files) return file(rel, files[rel]);
      throw { code: "not_found" };
    },
    fileWrite: fileWrite as never,
  };
  const draw = () => { hooks.cursor = 0; return McpConfigs({ api, repoPath: "/repo" }); };
  const html = () => renderToStaticMarkup(draw());
  const button = (text: string) => nodes(draw()).find((n) => n.props.children === text && n.props.onClick)!;
  const load = async () => { draw(); hooks.effects[0](); await tick(); };
  return { api, fileWrite, draw, html, button, load };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

it("shows a row per found file with its server count, transport and Open", async () => {
  const v = setup({ ".mcp.json": JSON.stringify({ mcpServers: { files: { command: "x", env: { A: "secret-value", B: "y" } }, web: { url: "https://example.test", disabled: true } } }) });
  await v.load();
  const html = v.html();
  expect(html).toContain(".mcp.json");
  expect(html).toContain(en("settings.repos.mcp.servers", { count: 2 }));
  expect(html).toContain(en("settings.repos.mcp.env", { count: 2 }));
  expect(html).toContain("stdio");
  expect(html).toContain("http");
  expect(html).toContain(en("settings.repos.mcp.disabled"));
  expect(html).not.toContain("secret-value");
  expect(html).not.toContain(en("settings.repos.mcp.empty"));
  const opened: OpenFileRequest[] = [];
  const stop = onOpenFile((req) => opened.push(req));
  v.button(en("settings.repos.mcp.open")).props.onClick();
  stop();
  expect(opened).toEqual([{ worktree: "/repo", rel: ".mcp.json" }]);
});

it("names an invalid file by why it cannot be read", async () => {
  const v = setup({ ".mcp.json": "{ nope", ".claude.json": "{}" });
  await v.load();
  const html = v.html();
  expect(html).toContain(en("settings.repos.mcp.invalid.json"));
  expect(html).toContain(en("settings.repos.mcp.invalid.shape"));
});

it("a missing .mcp.json shows the empty text and Add, which asks first", async () => {
  const v = setup({});
  await v.load();
  expect(v.html()).toContain(en("settings.repos.mcp.empty"));
  v.button(en("settings.repos.mcp.add")).props.onClick();
  const html = v.html();
  expect(html).toContain(en("settings.repos.mcp.confirm"));
  expect(html).toContain(en("settings.repos.mcp.cancel"));
  expect(v.fileWrite).not.toHaveBeenCalled();
  v.button(en("settings.repos.mcp.cancel")).props.onClick();
  expect(v.html()).toContain(en("settings.repos.mcp.add"));
});

it("confirming writes the starter, which must not exist yet, then toasts and reads again", async () => {
  const files: Files = {};
  const v = setup(files, async () => { files[".mcp.json"] = MCP_STARTER; return { type: "saved", hash: "h" }; });
  await v.load();
  v.button(en("settings.repos.mcp.add")).props.onClick();
  v.button(en("settings.repos.mcp.confirm")).props.onClick();
  await tick();
  expect(v.fileWrite).toHaveBeenCalledWith("/repo", ".mcp.json", MCP_STARTER, "lf", null);
  expect(getToasts().some((x) => x.text === en("settings.repos.mcp.created"))).toBe(true);
  const html = v.html();
  expect(html).toContain(en("settings.repos.mcp.servers", { count: 0 }));
  expect(html).not.toContain(en("settings.repos.mcp.empty"));
});

it("a conflict reads again and shows what is there, without a toast", async () => {
  const files: Files = {};
  const v = setup(files, async () => { files[".mcp.json"] = '{"mcpServers":{"a":{"command":"x"}}}'; return { type: "conflict", diskHash: "d" }; });
  await v.load();
  const before = getToasts().length;
  v.button(en("settings.repos.mcp.add")).props.onClick();
  v.button(en("settings.repos.mcp.confirm")).props.onClick();
  await tick();
  expect(getToasts()).toHaveLength(before);
  const html = v.html();
  expect(html).toContain(en("settings.repos.mcp.servers", { count: 1 }));
  expect(html).not.toContain(en("settings.repos.mcp.failed"));
});

it("a failed write shows the failure text and keeps Add available", async () => {
  const v = setup({}, async () => { throw { code: "io" }; });
  await v.load();
  v.button(en("settings.repos.mcp.add")).props.onClick();
  v.button(en("settings.repos.mcp.confirm")).props.onClick();
  await tick();
  const html = v.html();
  expect(html).toContain(en("settings.repos.mcp.failed"));
  expect(html).toContain(en("settings.repos.mcp.empty"));
});

it("every button is type button, because the group sits inside the repo form", async () => {
  const v = setup({ ".mcp.json": '{"mcpServers":{}}' });
  await v.load();
  const buttons = [...v.html().matchAll(/<button\b[^>]*>/g)].map((m) => m[0]);
  expect(buttons.length).toBeGreaterThan(0);
  for (const b of buttons) expect(b).toContain('type="button"');
  const missing = setup({});
  hooks.values = []; hooks.effects = [];
  await missing.load();
  for (const m of missing.html().matchAll(/<button\b[^>]*>/g)) expect(m[0]).toContain('type="button"');
});
