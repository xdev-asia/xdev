import { describe, expect, it } from "vitest";
import { createMockApi } from "./api";

const WT = "/demo/wt/xdev-oak";

describe("mock terminal links", () => {
  it("resolves a printed path to a file of the worktree", async () => {
    const api = createMockApi({});
    expect(
      await api.fileLinksResolve(WT, [
        "src/App.tsx",
        "./src/App.tsx",
        `${WT}/src/App.tsx`,
        `file://${WT}/src/App.tsx`,
        "src/../README.md",
        "../outside.ts",
        "src",
        "missing.ts",
        ".git/config",
        "/elsewhere/src/App.tsx",
      ]),
    ).toEqual(["src/App.tsx", "src/App.tsx", "src/App.tsx", "src/App.tsx", "README.md", null, null, null, null, null]);
  });

  it("refuses more than 64 candidates and an unknown worktree lists nothing", async () => {
    const api = createMockApi({});
    await expect(api.fileLinksResolve(WT, Array.from({ length: 65 }, () => "a"))).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.fileLinksResolve(WT, ["x".repeat(4097)])).rejects.toMatchObject({ code: "bad_arg" });
    await expect(api.fileLinksResolve("/nowhere", ["a.ts"])).rejects.toMatchObject({ code: "worktree_unknown" });
  });

  it("records default-app opens and refuses a runnable file", async () => {
    const api = createMockApi({});
    await api.fileOpenDefault(WT, "README.md");
    expect(api.__defaultOpens()).toEqual([{ worktree: WT, rel: "README.md" }]);
    await api.fileCreate(WT, "run.CMD", false);
    await expect(api.fileOpenDefault(WT, "run.CMD")).rejects.toMatchObject({ code: "denied" });
    await expect(api.fileOpenDefault(WT, "missing.md")).rejects.toMatchObject({ code: "not_found" });
    await expect(api.fileOpenDefault(WT, "../x.md")).rejects.toMatchObject({ code: "bad_path" });
    expect(api.__defaultOpens()).toHaveLength(1);
  });

  it("opens http and https only", async () => {
    const api = createMockApi({});
    await api.openUrl("https://x.dev/a?b=1&c#d");
    await api.openUrl("HTTP://x.dev");
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "mailto:a@b.c", "https://x.dev/a b", "https://x.dev/\n", `https://x.dev/${"a".repeat(2048)}`]) {
      await expect(api.openUrl(bad)).rejects.toMatchObject({ code: "bad_arg" });
    }
    expect(api.__openedUrls()).toEqual(["https://x.dev/a?b=1&c#d", "HTTP://x.dev"]);
  });

  it("builds a hosted URL with a line range", async () => {
    const api = createMockApi({});
    expect(await api.fileRemoteUrl(WT, "src/App.tsx", 12, null)).toBe("https://github.com/xdev-asia/demo/blob/main/src/App.tsx#L12");
    expect(await api.fileRemoteUrl(WT, "src/App.tsx", 12, 15)).toBe("https://github.com/xdev-asia/demo/blob/main/src/App.tsx#L12-L15");
    expect(await api.fileRemoteUrl(WT, "src/App.tsx", 12, 12)).toMatch(/#L12$/);
  });
});
