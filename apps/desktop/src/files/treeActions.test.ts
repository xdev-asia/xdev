import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { FileTabs } from "./fileTabs";
import { onOpenFile, type OpenFileRequest } from "./openFile";
import { absolutePath, copyRelative, createEntry, deleteEntry, renameEntry, type TreeIo } from "./treeActions";

const W = "C:\\wt\\a";
const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
let store: FileTabs;
const io = (api = createMockApi({})): TreeIo => ({ api, store, worktree: W, t });
const opened: OpenFileRequest[] = [];
let stop: () => void;
const text = (rel: string) => ({ text: "x", kind: "text", hash: "h", eol: "lf", size: 1, rel }) as never;

beforeEach(() => {
  store = new FileTabs();
  opened.length = 0;
  stop = onOpenFile((r) => opened.push(r));
  resetToastsForTests();
});
afterEach(() => {
  stop();
  vi.unstubAllGlobals();
});

it("builds the absolute path with the worktree's own separator", () => {
  expect(absolutePath("C:\\wt\\a", "src/a.ts")).toBe("C:\\wt\\a\\src\\a.ts");
  expect(absolutePath("/home/x/wt/", "src/a.ts")).toBe("/home/x/wt/src/a.ts");
});

it("Copy Path writes the absolute path, Copy Relative Path forward slashes", async () => {
  const write = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText: write } });
  const { copyAbsolute } = await import("./treeActions");
  await copyAbsolute(io(), "src/a.ts");
  await copyRelative("src\\a.ts");
  expect(write.mock.calls).toEqual([["C:\\wt\\a\\src\\a.ts"], ["src/a.ts"]]);
});

it("New File calls fileCreate, then opens it; New Folder only creates", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "fileCreate").mockResolvedValue(undefined);
  expect(await createEntry(io(api), "src", "n.ts", false)).toBe("src");
  expect(create).toHaveBeenCalledWith(W, "src/n.ts", false);
  expect(opened).toEqual([{ worktree: W, rel: "src/n.ts" }]);
  expect(await createEntry(io(api), "", "pkg", true)).toBe("");
  expect(create).toHaveBeenLastCalledWith(W, "pkg", true);
  expect(opened).toHaveLength(1);
});

it("a refused create is a toast, and nothing opens", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "fileCreate").mockRejectedValue({ code: "already_exists", message: "" });
  expect(await createEntry(io(api), "", "a.ts", false)).toBeNull();
  expect(opened).toEqual([]);
  expect(getToasts()).toHaveLength(1);
});

it("Rename of an open file retitles its tab; a folder moves what is under it", async () => {
  const api = createMockApi({});
  const rename = vi.spyOn(api, "fileRename").mockResolvedValue(undefined);
  store.open(W, "src/a.ts");
  store.loaded(W, "src/a.ts", text("src/a.ts"));
  store.open(W, "src/deep/b.ts");
  expect(await renameEntry(io(api), "src/a.ts", "z.ts")).toBe("src");
  expect(rename).toHaveBeenCalledWith(W, "src/a.ts", "src/z.ts");
  expect(store.get(W, "src/z.ts")).toMatchObject({ text: "x" });
  expect(store.get(W, "src/a.ts")).toBeNull();
  await renameEntry(io(api), "src", "lib");
  expect(store.get(W, "lib/deep/b.ts")).not.toBeNull();
});

it("Delete calls fileTrash, closes the tabs under it and says so", async () => {
  const api = createMockApi({});
  const trash = vi.spyOn(api, "fileTrash").mockResolvedValue(undefined);
  store.open(W, "src/a.ts");
  store.open(W, "src/b/c.ts");
  store.open(W, "other.ts");
  expect(await deleteEntry(io(api), "src")).toBe("");
  expect(trash).toHaveBeenCalledWith(W, "src");
  expect(store.list(W).map((e) => e.rel)).toEqual(["other.ts"]);
  expect(getToasts()[0].text).toBe(t("files.deleted", { name: "src" }));
});

it("a refused delete keeps the tabs and shows the error", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "fileTrash").mockRejectedValue({ code: "denied", message: "" });
  store.open(W, "a.ts");
  expect(await deleteEntry(io(api), "a.ts")).toBeNull();
  expect(store.get(W, "a.ts")).not.toBeNull();
  expect(getToasts()).toHaveLength(1);
});
