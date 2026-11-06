import { expect, test, vi } from "vitest";
import type { RemoteHostView } from "./api";
import { createMockApi, DEMO_SEED } from "./mockApi";
import { joinRel, parseRemote } from "./mockRemoteSsh";
import { REMOTE_UNSUPPORTED } from "./mockRemoteSsh";

const WT = "ssh://devbox/home/dev/app";

test("add a project, browse, read and write with a hash check", async () => {
  const api = createMockApi(DEMO_SEED);

  const home = await api.remoteBrowse("devbox");
  expect(home.path).toBe("/home/dev");
  expect(home.parent).toBe("/home");
  expect(home.dirs).toEqual([{ name: "app", path: "/home/dev/app" }]);
  expect((await api.remoteBrowse("devbox", "/home/dev/app")).dirs.map((d) => d.name)).toEqual([".git", "src"]);
  await expect(api.remoteBrowse("devbox", "/nope")).rejects.toMatchObject({ code: "remote_path" });
  await expect(api.remoteBrowse("ghost")).rejects.toMatchObject({ code: "not_found" });

  const project = await api.remoteProjectAdd("devbox", "/home/dev/app");
  expect(project).toMatchObject({ hostId: "devbox", path: "/home/dev/app", name: "app", hostAlias: "devbox", worktree: WT, keepAlive: true, state: { state: "connected", tmux: true, git: true } });
  expect(await api.remoteProjectsList()).toEqual([project]);
  // The same folder twice is one project.
  expect((await api.remoteProjectAdd("devbox", "~/app")).id).toBe(project.id);

  expect((await api.filesList(WT)).files).toEqual(["README.md", "src/main.ts"]);
  const file = await api.fileRead(WT, "src/main.ts");
  expect(file).toMatchObject({ rel: "src/main.ts", kind: "text", eol: "lf" });
  await expect(api.fileRead(WT, "../secret")).rejects.toMatchObject({ code: "bad_path" });

  const saved = await api.fileWrite(WT, "src/main.ts", "export {};\n", "lf", file.hash);
  expect(saved.type).toBe("saved");
  // The old hash no longer matches what is on the host.
  const stale = await api.fileWrite(WT, "src/main.ts", "lost\n", "lf", file.hash);
  expect(stale).toEqual({ type: "conflict", diskHash: saved.type === "saved" ? saved.hash : "" });
  expect((await api.fileRead(WT, "src/main.ts")).text).toBe("export {};\n");
  expect(await api.worktreeChanges(WT)).toEqual([{ path: "src/main.ts", kind: "modified" }]);

  // A local worktree still goes to the local mock.
  await expect(api.fileRead("/not/a/worktree", "a.md")).rejects.toMatchObject({ code: "worktree_unknown" });

  await api.remoteProjectRemove(project.id);
  expect(await api.remoteProjectsList()).toEqual([]);
});

test("a drop emits reconnecting then connected; offline rejects file calls", async () => {
  vi.useFakeTimers();
  try {
    const api = createMockApi(DEMO_SEED);
    await api.remoteProjectAdd("devbox", "/home/dev/app");
    const seen: RemoteHostView[] = [];
    await api.onRemoteState((v) => seen.push(v));

    api.__remoteDrop("devbox");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.map((v) => v.conn)).toEqual([{ state: "reconnecting", attempt: 1, nextInSecs: 1 }]);
    await expect(api.fileRead(WT, "README.md")).rejects.toMatchObject({ code: "remote_offline" });
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.map((v) => v.conn.state)).toEqual(["reconnecting", "connected"]);
    expect(seen[1]).toEqual({ hostId: "devbox", alias: "devbox", conn: { state: "connected", tmux: true, git: true } });
    expect((await api.fileRead(WT, "README.md")).kind).toBe("text");

    api.__remoteOffline("devbox");
    await vi.advanceTimersByTimeAsync(0);
    expect(seen.at(-1)?.conn).toEqual({ state: "offline", reason: "unreachable" });
    await expect(api.fileWrite(WT, "README.md", "x", "lf", null)).rejects.toMatchObject({ code: "remote_offline" });
    expect((await api.remoteHostsState()).find((h) => h.hostId === "devbox")?.conn.state).toBe("offline");

    await api.remoteConnect("devbox");
    await vi.advanceTimersByTimeAsync(2000);
    expect(seen.slice(-2).map((v) => v.conn.state)).toEqual(["connecting", "connected"]);
  } finally {
    vi.useRealTimers();
  }
});

test("remote targets are kept per project and cleared with null", async () => {
  const api = createMockApi(DEMO_SEED);
  expect(await api.remoteTargetGet("r1")).toBeNull();
  await api.remoteTargetSet("r1", { hostId: "devbox", path: "/home/dev/app" });
  expect(await api.remoteTargetGet("r1")).toEqual({ hostId: "devbox", path: "/home/dev/app" });
  await expect(api.remoteTargetSet("r1", { hostId: "ghost", path: "/x" })).rejects.toMatchObject({ code: "not_found" });
  await api.remoteTargetSet("r1", null);
  expect(await api.remoteTargetGet("r1")).toBeNull();
});

test("paths follow the Rust rules", () => {
  expect(parseRemote(WT)).toEqual({ hostId: "devbox", root: "/home/dev/app" });
  expect(parseRemote("/home/dev")).toBeNull();
  expect(parseRemote("ssh://dev.box/x")).toBeNull();
  expect(joinRel("/r", "./a//b")).toBe("/r/a/b");
  for (const bad of ["..", "a/../b", "/x", "a\0b", "a\\b", ""]) expect(joinRel("/r", bad)).toBeNull();
});

test("every remote error code is reachable", async () => {
  const api = createMockApi(DEMO_SEED);
  await api.remoteProjectAdd("devbox", "/home/dev/app");
  await expect(api.fileRead(WT, "nope.md")).rejects.toMatchObject({ code: "remote_path" });
  for (const code of ["remote_denied", "remote_too_large", "remote_auth", "remote_no_sftp", "remote_no_git", "remote_offline"] as const) {
    api.__remoteFail("devbox", code);
    await expect(api.fileRead(WT, "README.md")).rejects.toMatchObject({ code });
  }
  api.__remoteFail("devbox", null);
  expect((await api.fileRead(WT, "README.md")).kind).toBe("text");
  await expect(api.worktreeCommit(WT, ["README.md"], "x")).rejects.toMatchObject({ code: "remote_unsupported", detail: "worktree_commit" });
});

test("worktree calls the desktop guards refuse an ssh worktree and keep local ones", async () => {
  const api = createMockApi(DEMO_SEED);
  for (const [name, command] of Object.entries(REMOTE_UNSUPPORTED)) {
    const fn = api[name as keyof typeof REMOTE_UNSUPPORTED] as (first: string, ...rest: unknown[]) => Promise<unknown>;
    await expect(fn(WT)).rejects.toEqual({ code: "remote_unsupported", detail: command });
  }
  expect(await api.worktreeStat(WT)).toEqual({ files: 1, added: 0, removed: 0 });
  const local = (await api.workspaceList())[0].worktrees[0].path;
  expect((await api.worktreeStat(local)).files).toBeGreaterThanOrEqual(0);
});
