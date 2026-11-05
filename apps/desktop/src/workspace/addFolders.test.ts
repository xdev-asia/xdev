import { expect, it, vi } from "vitest";
import type { RepoView } from "@/api";
import { addFoldersNotice, addRepoFolders } from "./addFolders";

const repo = (path: string) => ({ id: path, path, worktrees: [] }) as unknown as RepoView;

it("adds the folders in order, the second only after the first is done", async () => {
  const log: string[] = [];
  const repoAdd = vi.fn(async (path: string) => {
    log.push(`start ${path}`);
    await Promise.resolve();
    await Promise.resolve();
    log.push(`end ${path}`);
    return repo(path);
  });
  const r = await addRepoFolders({ repoAdd }, ["/a", "/b"]);
  expect(log).toEqual(["start /a", "end /a", "start /b", "end /b"]);
  expect(r.added.map((x) => x.path)).toEqual(["/a", "/b"]);
  expect(r.failed).toEqual([]);
});

it("keeps going after a folder that fails and records its code", async () => {
  const repoAdd = vi.fn(async (path: string) => {
    if (path === "/bad") throw { code: "no_repo" };
    return repo(path);
  });
  const r = await addRepoFolders({ repoAdd }, ["/a", "/bad", "/c"]);
  expect(r.added.map((x) => x.path)).toEqual(["/a", "/c"]);
  expect(r.failed).toEqual([{ path: "/bad", code: "no_repo" }]);
});

it("does nothing for an empty list", async () => {
  const repoAdd = vi.fn();
  expect(await addRepoFolders({ repoAdd }, [])).toEqual({ added: [], failed: [] });
  expect(repoAdd).not.toHaveBeenCalled();
});

it("tells one failure by its code, several by a count, and a clean run by nothing", () => {
  const ok = { added: [repo("/a")], failed: [] };
  const bad = { added: [repo("/a")], failed: [{ path: "/b", code: "no_repo" as const }] };
  expect(addFoldersNotice(ok, 1)).toBeNull();
  expect(addFoldersNotice({ added: [], failed: bad.failed }, 1)).toEqual({ code: "no_repo" });
  expect(addFoldersNotice(bad, 2)).toEqual({ toast: { added: 1, total: 2, failed: 1 } });
});
