import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type Api, type QuickCommand } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { getQuickCommands, loadFileCommands, resetQuickCommands, selectCommands, startQuickCommands, trustFileCommands } from "./store";

const terminal = (label: string, scope: QuickCommand["scope"] = { type: "global" }): QuickCommand => ({
  id: "", label, scope, action: { type: "terminal", command: label.toLowerCase(), appendEnter: true },
});
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(resetQuickCommands);
afterEach(resetQuickCommands);

it("loads the list once and reloads when quickCommands changed", async () => {
  const api = createMockApi({});
  const stop = startQuickCommands(api);
  await flush();
  expect(getQuickCommands().items).toEqual([]);
  await api.quickCommandUpsert(terminal("Status"));
  await flush();
  expect(getQuickCommands().items.map((c) => c.label)).toEqual(["Status"]);
  stop();
  await api.quickCommandUpsert(terminal("After"));
  await flush();
  expect(getQuickCommands().items).toHaveLength(1);
});

it("ignores a change to other sections", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "quickCommandsList");
  startQuickCommands(api);
  await flush();
  const calls = list.mock.calls.length;
  await api.terminalSettingsPut(await api.terminalSettings());
  await flush();
  expect(list.mock.calls.length).toBe(calls);
});

it("selects global and the repo's own commands, and the recent ones that still exist", async () => {
  const api = createMockApi({});
  const [repoA, repoB] = [(await api.workspaceList())[0].path, "/other"];
  const g = await api.quickCommandUpsert(terminal("G"));
  const a = await api.quickCommandUpsert(terminal("A", { type: "repo", repo: repoA }));
  await api.quickCommandUsed(a.id);
  await api.quickCommandUsed(g.id);
  startQuickCommands(api);
  await flush();
  const snap = getQuickCommands();
  expect(selectCommands(snap, repoA).project.map((c) => c.label)).toEqual(["A"]);
  expect(selectCommands(snap, repoA).global.map((c) => c.label)).toEqual(["G"]);
  expect(selectCommands(snap, repoB).project).toEqual([]);
  expect(selectCommands(snap, null).project).toEqual([]);
  expect(selectCommands(snap, repoA).recent.map((c) => c.label)).toEqual(["G", "A"]);
  expect(selectCommands(snap, repoB).recent.map((c) => c.label)).toEqual(["G"]);
});

it("caches file commands per worktree and trusts by hash", async () => {
  const commands = [{ label: "Lint", action: { type: "terminal" as const, command: "pnpm lint", appendEnter: true } }];
  const api = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, repoFiles: { "/demo/xdev": { commands, commandErrors: [] } } } });
  const path = (await api.workspaceList())[0].worktrees[1].path;
  const read = vi.spyOn(api, "repoFileCommands");
  await loadFileCommands(api, path);
  await loadFileCommands(api, path);
  expect(read).toHaveBeenCalledTimes(1);
  expect(getQuickCommands().files[path]).toMatchObject({ trusted: false });
  await loadFileCommands(api, path, true);
  expect(read).toHaveBeenCalledTimes(2);
  const hash = getQuickCommands().files[path]!.hash;
  expect(await trustFileCommands(api, path, hash)).toBe(true);
  expect(getQuickCommands().files[path]).toMatchObject({ trusted: true });
});

it("a failed read leaves nothing cached", async () => {
  const api = { repoFileCommands: vi.fn().mockRejectedValue({ code: "worktree_unknown" }) } as unknown as Api;
  await loadFileCommands(api, "/x");
  expect(getQuickCommands().files["/x"]).toBeUndefined();
});
