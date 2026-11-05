import { expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { scanPorts } from "./usePorts";

it("asks only for worktrees that have a terminal and keys the answer by path", async () => {
  const api = createMockApi({});
  const scan = vi.spyOn(api, "portsScan");
  const ids: Record<string, string[]> = { "/a": ["t1", "t2"], "/b": [] };
  const found = await scanPorts(api, { ptyIds: (p) => ids[p] ?? [] }, ["/a", "/b"]);
  expect(scan).toHaveBeenCalledWith([{ path: "/a", ptyIds: ["t1", "t2"] }]);
  expect(Object.keys(found)).toEqual(["/a"]);
  expect(found["/a"].map((p) => p.port)).toEqual([5173, 8080]);
});

it("makes no call when no worktree has a terminal", async () => {
  const api = createMockApi({});
  const scan = vi.spyOn(api, "portsScan");
  expect(await scanPorts(api, { ptyIds: () => [] }, ["/a"])).toEqual({});
  expect(scan).not.toHaveBeenCalled();
});

it("the mock stops a process once confirmed and then no longer lists it", async () => {
  const api = createMockApi({});
  const [first] = (await api.portsScan([{ path: "/a", ptyIds: ["t"] }]))[0].ports;
  await expect(api.portStop(["t"], first.pid, false)).rejects.toMatchObject({ code: "needs_approval" });
  await api.portStop(["t"], first.pid, true);
  expect((await api.portsScan([{ path: "/a", ptyIds: ["t"] }]))[0].ports.map((p) => p.pid)).not.toContain(first.pid);
});
