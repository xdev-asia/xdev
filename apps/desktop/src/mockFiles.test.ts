import { describe, expect, it } from "vitest";
import { createMockApi, type FsChanged, type SearchEvent, type SearchQuery } from "./api";
import { createMockWorkspace } from "./mockWorkspace";

const WT = "/demo/wt/xdev-oak";

async function names(api: ReturnType<typeof createMockWorkspace>, dir: string): Promise<string[]> {
  return (await api.worktreeListDir(WT, dir)).entries.map((e) => (e.dir ? `${e.name}/` : e.name));
}

describe("mock files", () => {
  it("reads a text file with a hash and an eol, and binary files without text", async () => {
    const api = createMockWorkspace();
    const file = await api.fileRead(WT, "src/session.ts");
    expect(file).toMatchObject({ rel: "src/session.ts", kind: "text", eol: "lf" });
    expect(file.text).toContain("src/session.ts");
    expect(file.hash).toMatch(/^[0-9a-f]{8}$/);
    api.__editFile(WT, "logo.png", "\u0000png");
    expect(await api.fileRead(WT, "logo.png")).toMatchObject({ kind: "binary", text: null });
  });

  it("saves against the loaded hash and reports a conflict when the disk moved", async () => {
    const api = createMockWorkspace();
    const loaded = await api.fileRead(WT, "README.md");
    const saved = await api.fileWrite(WT, "README.md", "one\ntwo\n", "crlf", loaded.hash);
    expect(saved.type).toBe("saved");
    const again = await api.fileRead(WT, "README.md");
    expect(again).toMatchObject({ text: "one\r\ntwo\r\n", eol: "crlf" });
    // The old hash no longer matches, and nothing is written.
    expect(await api.fileWrite(WT, "README.md", "lost", "lf", loaded.hash)).toEqual({ type: "conflict", diskHash: again.hash });
    // Another program changed it.
    api.__editFile(WT, "README.md", "theirs\n");
    expect((await api.fileWrite(WT, "README.md", "mine", "lf", again.hash)).type).toBe("conflict");
    // A file that must not exist yet, and a file that is gone.
    expect((await api.fileWrite(WT, "package.json", "{}", "lf", null)).type).toBe("conflict");
    api.__editFile(WT, "README.md", null);
    expect(await api.fileWrite(WT, "README.md", "x", "lf", again.hash)).toEqual({ type: "conflict", diskHash: "" });
  });

  it("creates, renames and trashes, and the listing follows", async () => {
    const api = createMockWorkspace();
    await api.fileCreate(WT, "notes", true);
    expect(await names(api, "notes")).toEqual([]);
    await api.fileCreate(WT, "notes/a.md", false);
    expect((await api.fileRead(WT, "notes/a.md")).text).toBe("");
    await expect(api.fileCreate(WT, "notes/a.md", false)).rejects.toMatchObject({ code: "exists" });
    await expect(api.fileCreate(WT, "nope/a.md", false)).rejects.toMatchObject({ code: "not_found" });

    await api.fileRename(WT, "notes", "memo");
    expect(await names(api, "memo")).toEqual(["a.md"]);
    await expect(api.worktreeListDir(WT, "notes")).rejects.toMatchObject({ code: "not_found" });
    await expect(api.fileRename(WT, "memo/a.md", "README.md")).rejects.toMatchObject({ code: "exists" });
    // Only the case changes: the same entry.
    await api.fileRename(WT, "memo/a.md", "memo/A.md");
    expect(await names(api, "memo")).toEqual(["A.md"]);

    await api.fileTrash(WT, "memo");
    expect(await names(api, "")).not.toContain("memo/");
    await expect(api.fileRead(WT, "memo/A.md")).rejects.toMatchObject({ code: "not_found" });
    await api.fileCreate(WT, "memo", true);
    expect(await names(api, "memo")).toEqual([]);
  });

  it("refuses paths that leave the worktree and unknown worktrees", async () => {
    const api = createMockWorkspace();
    await expect(api.fileRead("/nowhere", "README.md")).rejects.toMatchObject({ code: "worktree_unknown" });
    for (const rel of ["", "../x", "src/../../x", "/etc/passwd", "C:x", "src\\x", ".git/config", "src/.GIT"]) {
      await expect(api.fileRead(WT, rel)).rejects.toMatchObject({ code: "bad_path" });
      await expect(api.fileWrite(WT, rel, "", "lf", null)).rejects.toMatchObject({ code: "bad_path" });
      await expect(api.fileCreate(WT, rel, false)).rejects.toMatchObject({ code: "bad_path" });
      await expect(api.fileTrash(WT, rel)).rejects.toMatchObject({ code: "bad_path" });
    }
    await expect(api.fileRename(WT, "README.md", "../README.md")).rejects.toMatchObject({ code: "bad_path" });
    await expect(api.fileRead(WT, "src")).rejects.toMatchObject({ code: "bad_path" });
    await expect(api.fileRead(WT, "missing.ts")).rejects.toMatchObject({ code: "not_found" });
  });

  it("is part of the mock api and records reveals", async () => {
    const api = createMockApi({});
    await api.fileReveal(WT, "./src/App.tsx");
    expect(api.__fileReveals()).toEqual([{ worktree: WT, rel: "src/App.tsx" }]);
    expect((await api.editorSettingsPut({ autosave: true, autosaveMs: 5, fontSize: 99, wordWrap: true, tabSize: 2 })).autosaveMs).toBe(250);
  });
});

describe("mock search", () => {
  const query = (text: string, more: Partial<SearchQuery> = {}): SearchQuery => ({
    text, caseSensitive: false, wholeWord: false, regex: false, include: [], exclude: [], ...more,
  });

  async function run(api: ReturnType<typeof createMockWorkspace>, q: SearchQuery, id = "s1"): Promise<SearchEvent[]> {
    const events: SearchEvent[] = [];
    await api.filesSearch(WT, q, id, (e) => events.push(e));
    return events;
  }

  it("lists the worktree's files sorted and rejects an unknown worktree", async () => {
    const api = createMockWorkspace();
    const list = await api.filesList(WT);
    expect(list.truncated).toBe(false);
    expect(list.files).toContain("src/session.ts");
    expect(list.files).toEqual([...list.files].sort());
    await expect(api.filesList("/nowhere")).rejects.toMatchObject({ code: "worktree_unknown" });
  });

  it("sends one batch and one done with the matching lines", async () => {
    const api = createMockWorkspace();
    api.__editFile(WT, "src/a.ts", "const dir_under = 1;\r\nfn under() {}\n");
    const events = await run(api, query("under", { wholeWord: true, include: ["src/**/*.ts"] }));
    expect(events.map((e) => e.type)).toEqual(["batch", "done"]);
    const batch = events[0] as Extract<SearchEvent, { type: "batch" }>;
    expect(batch.files).toEqual([{ rel: "src/a.ts", hits: [{ line: 2, text: "fn under() {}", ranges: [[3, 8]] }], more: false }]);
    expect(events[1]).toMatchObject({ type: "done", files: 1, hits: 1, truncated: false });
  });

  it("sends an error for a bad regex and nothing for a cancelled search", async () => {
    const api = createMockWorkspace();
    expect(await run(api, query("(", { regex: true }))).toEqual([{ type: "error", message: expect.any(String) }]);
    const events: SearchEvent[] = [];
    const pending = api.filesSearch(WT, query("export"), "s2", (e) => events.push(e));
    await api.filesSearchCancel("s2");
    await pending;
    expect(events).toEqual([]);
  });
  it("tells a watcher what changed, and stops when it unwatches", async () => {
    const api = createMockWorkspace();
    const got: FsChanged[] = [];
    await api.filesWatch(WT, "w1", (e) => got.push(e));
    expect(api.__watchers()).toEqual([{ worktree: WT, id: "w1" }]);
    api.__editFile(WT, "README.md", "changed\n");
    api.__editFile(WT, "fresh.txt", "new\n");
    api.__editFile(WT, "README.md", null);
    expect(got.map((b) => b.events)).toEqual([
      [{ kind: "update", rel: "README.md", dir: false }],
      [{ kind: "create", rel: "fresh.txt", dir: false }],
      [{ kind: "delete", rel: "README.md", dir: null }],
    ]);
    expect(got[0].worktree).toBe(WT);
    api.__overflow(WT);
    expect(got[3].events).toEqual([{ kind: "overflow", rel: "", dir: null }]);
    await api.filesUnwatch("w1");
    api.__editFile(WT, "fresh.txt", "again\n");
    expect(got).toHaveLength(4);
    expect(api.__watchers()).toEqual([]);
  });

  it("emits for its own writes, creates, renames and trashes, and refuses an unknown worktree", async () => {
    const api = createMockWorkspace();
    const got: FsChanged["events"][] = [];
    await api.filesWatch(WT, "w", (e) => got.push(e.events));
    const file = await api.fileRead(WT, "README.md");
    await api.fileWrite(WT, "README.md", "x\n", "lf", file.hash);
    await api.fileCreate(WT, "notes", true);
    await api.fileRename(WT, "README.md", "notes/README.md");
    await api.fileTrash(WT, "notes/README.md");
    expect(got).toEqual([
      [{ kind: "update", rel: "README.md", dir: false }],
      [{ kind: "create", rel: "notes", dir: true }],
      [
        { kind: "delete", rel: "README.md", dir: null },
        { kind: "create", rel: "notes/README.md", dir: false },
      ],
      [{ kind: "delete", rel: "notes/README.md", dir: null }],
    ]);
    await expect(api.filesWatch("/nope", "x", () => {})).rejects.toMatchObject({ code: "worktree_unknown" });
  });
});
