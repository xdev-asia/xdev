import { describe, expect, it } from "vitest";
import { createMockApi, type SettingsSection } from "./api";
import type { CloneProgress } from "./api";
import { OPEN_IN_DEFAULTS } from "./mockOpenIn";

const app = (id: string, command = "x") => ({ id, label: id, command, args: [] });

describe("mock open in", () => {
  it("starts with VS Code and stores a valid list", async () => {
    const api = createMockApi({});
    expect(await api.openInSettings()).toEqual(OPEN_IN_DEFAULTS);
    const heard: SettingsSection[][] = [];
    api.onSettingsChanged((e) => heard.push(e.sections));
    const next = { apps: [...OPEN_IN_DEFAULTS.apps, { id: "app-1", label: "Cursor", command: "cursor", args: ["-n"] }] };
    expect(await api.openInSettingsPut(next)).toEqual(next);
    expect(await api.openInSettings()).toEqual(next);
    expect(heard).toEqual([["openIn"]]);
  });

  it("refuses a bad list", async () => {
    const api = createMockApi({});
    const nine = { apps: Array.from({ length: 9 }, (_, i) => app(`a${i}`)) };
    await expect(api.openInSettingsPut(nine)).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.openInSettingsPut({ apps: [app("a"), app("a")] })).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.openInSettingsPut({ apps: [{ ...app("a"), label: "" }] })).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.openInSettingsPut({ apps: [app("a", "code --new")] })).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("records openIn calls and rejects an unknown app", async () => {
    const api = createMockApi({});
    await api.openIn("/r/wt", { type: "app", id: "vscode" });
    await api.openIn("/r/wt", { type: "fileManager" });
    await expect(api.openIn("/r/wt", { type: "app", id: "nope" })).rejects.toMatchObject({ code: "not_found" });
    expect(api.__openInCalls()).toEqual([
      { path: "/r/wt", target: { type: "app", id: "vscode" } },
      { path: "/r/wt", target: { type: "fileManager" } },
    ]);
  });

  it("names a clone from its URL", async () => {
    const api = createMockApi({});
    for (const url of ["https://github.com/a/xdev.git", "git@github.com:a/xdev.git", "https://host/a/xdev/"]) {
      expect(await api.repoCloneName(url)).toBe("xdev");
    }
    await expect(api.repoCloneName("")).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("clones with two phases and done, and the repo is listed", async () => {
    const api = createMockApi({});
    const events: CloneProgress[] = [];
    await api.repoClone("https://host/a/fresh.git", "/code", null, "c1", (e) => events.push(e));
    expect(events.map((e) => e.type)).toEqual(["phase", "phase", "done"]);
    const done = events[2];
    expect(done.type === "done" && done.repo.path).toBe("/code/fresh");
    expect((await api.workspaceList()).some((r) => r.path === "/code/fresh")).toBe(true);
    await expect(api.repoClone("-u", "/code", null, "c2", () => {})).rejects.toMatchObject({ code: "bad_arg" });
  });

  it("a cancelled clone ends with error and rejects", async () => {
    const api = createMockApi({});
    const events: CloneProgress[] = [];
    const run = api.repoClone("https://host/a/slow.git", "/code", null, "c3", (e) => events.push(e));
    await api.repoCloneCancel("c3");
    await expect(run).rejects.toMatchObject({ code: "cancelled" });
    expect(events.at(-1)?.type).toBe("error");
  });
});
