import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { mount, nodes, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { SECTIONS } from "../sections";
import { runSearch } from "../searchModel";
import { McpPage } from "./McpPage";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

async function open(api = createMockApi({})) {
  const m = mount(McpPage, () => ({ api, onChanged: vi.fn() }));
  await m.settle();
  await m.settle();
  return { api, m };
}
const TOOLS = ["list_tabs", "list_worktrees", "list_ports", "read_tab_output", "send_to_tab", "create_worktree"];
const switchOf = (all: Node[], tool: string) => all.find((n) => n.props["data-tool-switch"] === tool)!;

it("is the MCP section of Settings and the search finds its parts", () => {
  expect(SECTIONS.find((s) => s.id === "mcp")!.Component).toBe(McpPage);
  const t = (k: string) => translate("en", k);
  const ids = runSearch("send_to_tab", t, (id) => id).ids;
  expect(ids.has("mcp.tools")).toBe(true);
  for (const q of ["activity", "mcp.json", "gemini", "health"]) {
    expect([...runSearch(q, t, (id) => id).ids].some((i) => i.startsWith("mcp.")), q).toBe(true);
  }
});

it("lists every tool with the write tools off and marked sensitive", async () => {
  const { m } = await open();
  const all = m.all();
  const state = Object.fromEntries(["list_tabs", "list_worktrees", "list_ports", "read_tab_output", "send_to_tab", "create_worktree"].map((n) => [n, switchOf(all, n).props.checked]));
  expect(state).toEqual({ list_tabs: true, list_worktrees: true, list_ports: true, read_tab_output: false, send_to_tab: false, create_worktree: false });
  // The tag sits in the switch's label.
  const marked = TOOLS.filter((n) => nodes(switchOf(all, n).props.label).some((x) => x.props.tone === "warn" && textOf(x) === "Sensitive"));
  expect(marked).toEqual(["read_tab_output", "send_to_tab", "create_worktree"]);
});

it("turning on send_to_tab is stored, announced, and still on in a new page", async () => {
  const { api, m } = await open();
  switchOf(m.all(), "send_to_tab").props.onChange({ target: { checked: true } });
  await tick();
  const after = await m.settle();
  expect(switchOf(after, "send_to_tab").props.checked).toBe(true);
  const status = after.find((n) => n.props["data-status"] === "mcp-tools")!;
  expect(status.props.role).toBe("status");
  expect(textOf(status)).toBe("send_to_tab is on");
  // A fresh page reads it back from the app.
  const again = await open(api);
  expect(switchOf(again.m.all(), "send_to_tab").props.checked).toBe(true);
  expect(switchOf(again.m.all(), "list_tabs").props.checked).toBe(true);
});

it("turning a read tool off persists too", async () => {
  const { api, m } = await open();
  switchOf(m.all(), "list_ports").props.onChange({ target: { checked: false } });
  await tick();
  expect((await api.mcpToolsGet()).find((t) => t.name === "list_ports")!.enabled).toBe(false);
});

it("shows the activity newest first with ok and error, and never an argument", async () => {
  const { m } = await open();
  const rows = m.all().filter((n) => n.props.className === "mcp-call");
  expect(rows.map((r) => r.props["data-ok"])).toEqual([true, false, true]);
  expect(textOf(rows[0])).toContain("list_tabs");
  expect(m.all().some((n) => n.props["data-mcp"] === "last")).toBe(true);
});

it("reports a healthy server and an absent one", async () => {
  const ok = await open();
  const line = (m: typeof ok.m) => textOf(m.all().find((n) => n.props["data-mcp"] === "health")!);
  expect(line(ok.m)).toContain("xdev 0.7.0 starts and answers");
  const api = createMockApi({});
  api.mcpHealth = async () => ({ path: null, version: null, running: false });
  const down = await open(api);
  expect(line(down.m)).toContain("no working xdev");
});
