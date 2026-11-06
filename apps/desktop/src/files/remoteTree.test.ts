import { expect, it } from "vitest";
import { isRemoteWorktree, listingFromFiles } from "./remoteTree";

const LIST = { files: ["README.md", "src/lib/a.ts", "src/main.ts", "src/z.ts", "docs/guide.md"].sort(), truncated: false };

it("lists one folder of a file list, folders first", () => {
  expect(listingFromFiles(LIST, "")).toEqual({
    entries: [
      { name: "docs", dir: true, ignored: false },
      { name: "src", dir: true, ignored: false },
      { name: "README.md", dir: false, ignored: false },
    ],
    truncated: false,
  });
  expect(listingFromFiles(LIST, "src").entries).toEqual([
    { name: "lib", dir: true, ignored: false },
    { name: "main.ts", dir: false, ignored: false },
    { name: "z.ts", dir: false, ignored: false },
  ]);
  expect(listingFromFiles(LIST, "src/lib").entries).toEqual([{ name: "a.ts", dir: false, ignored: false }]);
  // A name that only starts like the folder is not in it.
  expect(listingFromFiles({ files: ["srcx/a.ts"], truncated: false }, "src").entries).toEqual([]);
});

it("says a cut file list may miss names", () => {
  expect(listingFromFiles({ ...LIST, truncated: true }, "src").truncated).toBe(true);
});

it("tells a remote worktree from a local one", () => {
  expect(isRemoteWorktree("ssh://devbox/home/dev/app")).toBe(true);
  expect(isRemoteWorktree("/home/dev/app")).toBe(false);
  expect(isRemoteWorktree("C:\ssh\app")).toBe(false);
});
