import { describe, expect, it } from "vitest";
import { createMockApi } from "@/api";
import { setUpVault } from "./setUpVault";

const starter = { file: "Getting started.md", content: "# Getting started\n" };

describe("setUpVault", () => {
  it("writes the starter into an empty folder, opens it and tracks it with git", async () => {
    const api = createMockApi({}, { repo: false });
    const docs = await setUpVault(api, "/x/xDev", starter);
    expect(docs.map((d) => d.path)).toEqual(["Getting started.md"]);
    expect(await api.vcsState()).toEqual({ status: "ok" });
    expect((await api.listChanges()).map((c) => [c.path, c.kind])).toEqual([["Getting started.md", "added"]]);
    expect(await api.lastVault()).toBe("/x/xDev");
  });

  it("leaves a folder with files alone", async () => {
    const api = createMockApi({ "notes.md": "# Notes\n" });
    const docs = await setUpVault(api, "/x/xDev", starter);
    expect(docs.map((d) => d.path)).toEqual(["notes.md"]);
  });

  it("still opens the folder when git tracking fails", async () => {
    const api = createMockApi({}, { repo: false });
    api.initRepo = () => Promise.reject({ code: "no_git" });
    const docs = await setUpVault(api, "/x/xDev", starter);
    expect(docs).toHaveLength(1);
  });

  it("rejects a starter name that is not a plain Markdown file, before opening anything", async () => {
    const api = createMockApi({});
    await expect(setUpVault(api, "/x/xDev", { ...starter, file: "a/b.md" })).rejects.toMatchObject({ code: "bad_path" });
    expect(await api.lastVault()).toBeNull();
  });

  it("answers the first-run prompt by opening a folder", async () => {
    const api = createMockApi({});
    expect((await api.vaultSetup()).prompt).toBe(true);
    await setUpVault(api, "/x/xDev", starter);
    expect((await api.vaultSetup()).prompt).toBe(false);
  });
});
