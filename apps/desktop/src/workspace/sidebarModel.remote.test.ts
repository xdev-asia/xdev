import { expect, it } from "vitest";
import type { RemoteConnState, RemoteProjectView } from "@/api";
import { applyState, projectOf, reconnectCandidate, remoteRepo } from "@/remote/model";
import { remoteRows, stateDot } from "./sidebarModel";

function project(id: string, hostId: string, addedMs: number, state: RemoteConnState = { state: "idle" }): RemoteProjectView {
  return { id, hostId, hostAlias: hostId, path: `/srv/${id}`, name: id, keepAlive: true, addedMs, worktree: `ssh://${hostId}/srv/${id}`, state } as RemoteProjectView;
}

it("maps each connection state to its dot", () => {
  expect(stateDot({ state: "connected", tmux: true, git: true })).toEqual({ tone: "ok" });
  expect(stateDot({ state: "connecting" })).toEqual({ tone: "warn" });
  expect(stateDot({ state: "reconnecting", attempt: 2 } as RemoteConnState)).toEqual({ tone: "warn" });
  expect(stateDot({ state: "offline" } as RemoteConnState)).toEqual({ tone: "danger" });
  expect(stateDot({ state: "idle" })).toEqual({ tone: "neutral" });
});

it("lists remote rows in the order projects were added, with host alias and worktree", () => {
  const rows = remoteRows([project("b", "devbox", 20), project("a", "box2", 10)]);
  expect(rows.map((r) => [r.name, r.host, r.worktree])).toEqual([
    ["a", "box2", "ssh://box2/srv/a"],
    ["b", "devbox", "ssh://devbox/srv/b"],
  ]);
});

it("a state event changes only the projects of its host", () => {
  const next = applyState([project("a", "devbox", 1), project("b", "box2", 2)], "devbox", { state: "offline" } as RemoteConnState);
  expect(remoteRows(next).map((r) => r.dot.tone)).toEqual(["danger", "neutral"]);
});

it("a remote project becomes a one-worktree repo on its ssh:// path", () => {
  const p = project("a", "devbox", 1);
  const repo = remoteRepo(p);
  expect(repo.id).toBe("remote:a");
  expect(repo.worktrees.map((w) => w.path)).toEqual(["ssh://devbox/srv/a"]);
  expect(projectOf([p], "ssh://devbox/srv/a")).toBe(p);
  expect(projectOf([p], "/local")).toBeUndefined();
});

it("Reconnect is offered only while a remote host is not connected", () => {
  const up: RemoteConnState = { state: "connected", tmux: true, git: true };
  expect(reconnectCandidate([])).toBeUndefined();
  expect(reconnectCandidate([project("a", "devbox", 1, up)])).toBeUndefined();
  expect(reconnectCandidate([project("a", "devbox", 1, up), project("b", "box2", 2, { state: "offline" } as RemoteConnState)])?.id).toBe("b");
});
