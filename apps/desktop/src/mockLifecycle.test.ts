import { describe, expect, it } from "vitest";
import { createMockApi, type SettingsSection, type SidebarItem } from "./api";
import { createMockWorkspace } from "./mockWorkspace";

const OAK = "/demo/wt/xdev-oak";
const ELM = "/demo/wt/xdev-elm";

function shape(items: SidebarItem[]): string[] {
  return items.map((i) => (i.kind === "repo" ? i.repo.shortName : i.kind === "folder" ? `f:${i.folder.name}` : `g:${i.group.name}[${shape(i.items).join(",")}]`));
}

describe("mock worktree lifecycle", () => {
  it("archives behind the gate and the dirty check, then restores with details", async () => {
    const api = createMockWorkspace();
    await api.worktreeDetails(ELM, { title: "Login", comment: "half done", status: "in-progress" });
    await expect(api.worktreeArchive(ELM, false, false)).rejects.toMatchObject({ code: "needs_approval" });
    await expect(api.worktreeArchive(OAK, false, true)).rejects.toMatchObject({ code: "worktree_dirty" });

    const removed = await api.worktreeArchive(ELM, false, true);
    expect(removed).toMatchObject({ deletedBranch: null, kept: { branch: "elm", reason: "archived", title: "Login" } });
    const [repo] = await api.workspaceSidebar();
    expect(repo.kind === "repo" && repo.kept.map((k) => [k.entry.branch, k.archivedShown])).toEqual([["elm", true]]);

    const back = await api.worktreeRestore("demo-xdev", "elm");
    expect(back).toMatchObject({ path: ELM, branch: "elm", title: "Login", comment: "half done", status: "in-progress" });
    await expect(api.worktreeRestore("demo-xdev", "elm")).rejects.toMatchObject({ code: "kept_unknown" });
  });

  it("checks details like Rust", async () => {
    const api = createMockWorkspace();
    await expect(api.worktreeDetails(ELM, { title: "x".repeat(121) })).rejects.toMatchObject({ code: "bad_details" });
    await expect(api.worktreeDetails(ELM, { item: { kind: "pr", url: "nope", title: null } })).rejects.toMatchObject({ code: "bad_item" });
    await expect(api.worktreeDetails(ELM, { parent: ELM })).rejects.toMatchObject({ code: "bad_parent" });
    await expect(api.worktreeDetails("/demo/xdev", { title: "x" })).rejects.toMatchObject({ code: "primary_worktree" });
    await api.worktreeDetails(ELM, { parent: OAK });
    const wts = (await api.workspaceList())[0].worktrees;
    expect(wts.find((w) => w.path === ELM)?.parent).toBe(OAK);
  });

  it("keeps or deletes a kept branch, the delete behind the gate", async () => {
    const api = createMockWorkspace();
    await api.worktreeArchive(ELM, false, true);
    await expect(api.branchDelete("demo-xdev", "elm", false)).rejects.toMatchObject({ code: "needs_approval" });
    await api.branchDelete("demo-xdev", "elm", true);
    await expect(api.keptKeep("demo-xdev", "elm")).rejects.toMatchObject({ code: "kept_unknown" });
    const removed = await api.worktreeRemove(OAK, true, true);
    expect(removed).toEqual({ deletedBranch: "oak", kept: null });
  });

  it("orders, groups and lists folders", async () => {
    const api = createMockWorkspace();
    const folder = await api.folderAdd("/demo/notes");
    await expect(api.folderAdd("/demo/notes")).rejects.toMatchObject({ code: "folder_exists" });
    await expect(api.folderAdd("/demo/xdev")).rejects.toMatchObject({ code: "folder_exists" });
    expect(shape(await api.workspaceSidebar())).toEqual(["xdev", "f:notes"]);

    const g = await api.groupPut(null, " Work ");
    await api.groupMove("demo-xdev", g, 0);
    expect(shape(await api.workspaceSidebar())).toEqual(["f:notes", "g:Work[xdev]"]);
    await api.sidebarOrder([g, "nope"]);
    expect(shape(await api.workspaceSidebar())).toEqual(["g:Work[xdev]", "f:notes"]);
    await api.groupRemove(g);
    expect(shape(await api.workspaceSidebar())).toEqual(["xdev", "f:notes"]);

    await api.folderForget(folder.id);
    expect(shape(await api.workspaceSidebar())).toEqual(["xdev"]);
    await expect(api.folderForget(folder.id)).rejects.toMatchObject({ code: "folder_unknown" });
    await expect(api.groupRemove("x")).rejects.toMatchObject({ code: "group_unknown" });
    await expect(api.groupPut(null, " ")).rejects.toMatchObject({ code: "bad_name" });
    await expect(api.groupMove("x", null, 0)).rejects.toMatchObject({ code: "repo_unknown" });
  });

  it("stores the sidebar filters and announces them", async () => {
    const api = createMockApi({});
    const heard: SettingsSection[][] = [];
    api.onSettingsChanged((e) => heard.push(e.sections));
    expect(await api.sidebarPrefsGet()).toEqual({ hideDefault: false, hideDetached: false, hideAutomation: false, hideCli: false });
    const stored = await api.sidebarPrefsPut({ hideDefault: true, hideDetached: false, hideAutomation: true, hideCli: false });
    expect(stored.hideAutomation).toBe(true);
    expect(await api.sidebarPrefsGet()).toEqual(stored);
    expect(heard).toEqual([["sidebar"]]);
  });
});
