import { describe, expect, it } from "vitest";
import type { WorktreeUsage } from "@/api";
import { createMockWorkspace, DEMO_WORKSPACE } from "@/mockWorkspace";
import { afterClean, cleanTargets, formatSize, heavyTotal, shortPath } from "./diskRows";

const row = (worktree: string, total: number, heavy: [string, number][]): WorktreeUsage => ({
  worktree,
  total,
  heavy: heavy.map(([path, size]) => ({ path, size })),
});

describe("disk usage rows", () => {
  it("words sizes up to terabytes", () => {
    expect(formatSize(512)).toBe("512 B");
    expect(formatSize(1536)).toBe("1.5 KB");
    expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatSize(3.2 * 1024 ** 3)).toBe("3.2 GB");
  });

  it("shortens a path to its last two folders, on either slash", () => {
    expect(shortPath("/home/me/wt/xdev-oak")).toBe("wt/xdev-oak");
    expect(shortPath("C:\\Codes\\xDev\\wt\\git-extras")).toBe("wt/git-extras");
  });

  it("deletes exactly the heavy folders the row lists", () => {
    const r = row("/w", 900, [["/w/node_modules", 600], ["/w/target", 200]]);
    expect(cleanTargets(r)).toEqual(["/w/node_modules", "/w/target"]);
    expect(heavyTotal(r)).toBe(800);
  });

  it("keeps the row after a clean with its heavy folders gone, and the rows sorted", () => {
    const rows = [row("/a", 900, [["/a/node_modules", 800]]), row("/b", 300, [])];
    const next = afterClean(rows, "/a");
    expect(next.map((r) => [r.worktree, r.total, r.heavy.length])).toEqual([["/b", 300, 0], ["/a", 100, 0]]);
  });
});

describe("mock disk usage", () => {
  const api = createMockWorkspace();

  it("scans the demo worktrees, the biggest first", async () => {
    const rows = await api.diskUsageScan();
    expect(rows.length).toBe(DEMO_WORKSPACE.repos.flatMap((r) => r.worktrees).length);
    expect(rows.map((r) => r.total)).toEqual([...rows.map((r) => r.total)].sort((a, b) => b - a));
  });

  it("cleans a heavy folder of a worktree and refuses anything else", async () => {
    const [first] = await api.diskUsageScan();
    await expect(api.diskUsageClean(first.heavy.map((h) => h.path))).resolves.toBeTypeOf("number");
    await expect(api.diskUsageClean([`${first.worktree}/src`])).rejects.toMatchObject({ code: "bad_path" });
    await expect(api.diskUsageClean(["/elsewhere/node_modules"])).rejects.toMatchObject({ code: "bad_path" });
  });
});
