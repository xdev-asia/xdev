import { describe, expect, it, vi } from "vitest";
import { AI_KEY_PROVIDERS, toApiError, type AiKeyProvider, type Api, type Change, type Seen } from "./api";
import { setVerified } from "./doc/frontmatter";
import {
  coverMatcher,
  createMockApi,
  defaultMessage,
  DEMO_COMMITS,
  DEMO_SEED,
  EXPORT_MARKER,
  setMockClipboardImage,
  type SeedCommit,
} from "./mockApi";

const seed = {
  "README.md": "# Hello\n\nWelcome to the vault.\n",
  "docs/kien-truc.md": "# Tài liệu kiến trúc\n\nHệ thống gồm ba lớp.\n",
  "docs/xss.md": "# Unsafe\n\n<img onerror=x> kiến trúc & more\n",
};

// The rows the review list shows for `paths`, as the UI sends them back; a path
// that is not pending goes as a deletion, like a stale or crafted call.
async function seenOf(api: Api, paths: string[]): Promise<Seen[]> {
  const changes = await api.listChanges();
  return paths.map((path) => changes.find((c) => c.path === path) ?? { path, hash: null });
}

// Hashes left out, so a case reads as a table.
function plain(changes: Change[]): Omit<Change, "hash">[] {
  return changes.map(({ hash: _, ...rest }) => rest);
}

async function opened(files: Record<string, string> = seed) {
  const api = createMockApi(files);
  await api.openVault("/vault");
  return api;
}

describe("mock api", () => {
  it("has no clipboard image by default and reports the US input source", async () => {
    const api = createMockApi(seed);
    expect(await api.clipboardImageSave()).toBeNull();
    expect(await api.keyboardInputSource()).toBe("com.apple.keylayout.US");
  });

  it("returns the clipboard image path, or rejects with the error, as set", async () => {
    const api = createMockApi(seed);
    setMockClipboardImage("/tmp/x.png");
    expect(await api.clipboardImageSave()).toBe("/tmp/x.png");
    setMockClipboardImage({ code: "too_large" });
    await expect(api.clipboardImageSave()).rejects.toEqual({ code: "too_large" });
    setMockClipboardImage(null);
  });

  it("rejects calls before a vault is open", async () => {
    await expect(createMockApi(seed).listDocs()).rejects.toEqual({ code: "no_vault" });
  });

  it("lists docs sorted with titles", async () => {
    const docs = await (await opened()).listDocs();
    expect(docs.map((d) => d.path)).toEqual(["docs/kien-truc.md", "docs/xss.md", "README.md"].sort());
    expect(docs.find((d) => d.path === "docs/kien-truc.md")?.title).toBe("Tài liệu kiến trúc");
    expect(docs.every((d) => d.skipped === null)).toBe(true);
  });

  it("marks invalid text as skipped not_utf8", async () => {
    const api = await opened({ "bad.md": "a\uD800b" });
    expect((await api.listDocs())[0]).toMatchObject({ title: "bad", skipped: "not_utf8" });
    await expect(api.readDoc("bad.md")).rejects.toEqual({ code: "not_utf8" });
  });

  it("mock search ignores diacritics", async () => {
    const hits = await (await opened()).search("tai lieu", 10);
    expect(hits.map((h) => h.path)).toEqual(["docs/kien-truc.md"]);
    expect(hits[0].snippet).toContain("<mark>");
  });

  it("mock search is case-insensitive and ANDs terms", async () => {
    const api = await opened();
    expect((await api.search("WELCOME vault", 10)).map((h) => h.path)).toEqual(["README.md"]);
    expect(await api.search("welcome kiến", 10)).toEqual([]);
    expect(await api.search("   ", 10)).toEqual([]);
  });

  it("mock snippet escapes html", async () => {
    const hits = await (await opened()).search("img", 10);
    expect(hits[0].snippet).toContain("&lt;<mark>img</mark> onerror=x&gt;");
    expect(hits[0].snippet).toContain("&amp;");
  });

  it("mock search respects limit", async () => {
    expect(await (await opened()).search("e", 2)).toHaveLength(2);
  });

  it("mock read rejects outside_vault", async () => {
    const api = await opened();
    await expect(api.readDoc("../x.md")).rejects.toEqual({ code: "outside_vault" });
    await expect(api.readDoc("docs/../../x.md")).rejects.toEqual({ code: "outside_vault" });
    await expect(api.readDoc("/etc/x.md")).rejects.toEqual({ code: "outside_vault" });
    await expect(api.readDoc("C:/x.md")).rejects.toEqual({ code: "outside_vault" });
    await expect(api.writeDoc("../x.md", "x")).rejects.toEqual({ code: "outside_vault" });
  });

  it("mock read of a missing doc rejects not_found", async () => {
    await expect((await opened()).readDoc("nope.md")).rejects.toEqual({ code: "not_found" });
  });

  it("mock write then read returns new content", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Changed\n");
    expect(await api.readDoc("README.md")).toBe("# Changed\n");
    expect((await api.listDocs()).find((d) => d.path === "README.md")?.title).toBe("Changed");
  });

  it("mock write notifies vault listeners", async () => {
    const api = await opened();
    const seen = new Promise<string[]>((resolve) => void api.onVaultChanged(resolve));
    await api.writeDoc("docs/new.md", "# New\n");
    expect(await seen).toEqual(["docs/new.md"]);
  });

  it("lastVault remembers the opened folder", async () => {
    const api = createMockApi(seed);
    expect(await api.lastVault()).toBeNull();
    await api.openVault("/vault");
    expect(await api.lastVault()).toBe("/vault");
  });

  it("demo seed has nested Vietnamese docs", async () => {
    const api = await opened(DEMO_SEED);
    const docs = await api.listDocs();
    expect(docs.length).toBeGreaterThanOrEqual(5);
    expect(docs.some((d) => d.path.split("/").length > 2)).toBe(true);
    expect((await api.search("tai lieu kien truc", 5))[0]?.title).toBe("Tài liệu kiến trúc");
  });
});

describe("mock vcs", () => {
  it("lists app and outside changes", async () => {
    const api = await opened();
    expect(await api.vcsState()).toEqual({ status: "ok" });
    expect(plain(await api.listChanges())).toEqual([]);
    await api.writeDoc("README.md", "# Mine\n");
    api.__editOutside("docs/kien-truc.md", "# Theirs\n");
    api.__editOutside("docs/xss.md", null);
    await api.writeDoc("docs/new.md", "# New\n");
    // Sorted by code unit, like the Rust side, so upper case comes first.
    expect(plain(await api.listChanges())).toEqual([
      { path: "README.md", kind: "modified", origin: "app", note: null },
      { path: "docs/kien-truc.md", kind: "modified", origin: "outside", note: null },
      { path: "docs/new.md", kind: "added", origin: "app", note: null },
      { path: "docs/xss.md", kind: "deleted", origin: "outside", note: null },
    ]);
    // Another program touching a file xDev wrote takes it over.
    api.__editOutside("README.md", "# Theirs now\n");
    expect((await api.listChanges()).find((c) => c.path === "README.md")?.origin).toBe("outside");
  });

  it("approve commits and clears", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    api.__editOutside("docs/kien-truc.md", "# Theirs\n");
    const id = await api.approve(await seenOf(api, ["README.md"]), "Reword the intro");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(plain(await api.listChanges())).toEqual([{ path: "docs/kien-truc.md", kind: "modified", origin: "outside", note: null }]);
    expect(await api.readBase("README.md")).toBe("# Mine\n");
    const [latest] = await api.history("README.md", 50);
    expect(latest).toMatchObject({ id, author: "You", message: "Reword the intro" });
    expect(latest.time).toBeGreaterThan(0);
    // Stale or crafted paths are ignored.
    expect(await api.approve(await seenOf(api, ["README.md", "zzz.md", "../etc.md"]), "")).toBeNull();
  });

  it("approve and reject refuse text edited after it was seen", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    const looked = await seenOf(api, ["README.md"]);
    // An agent proposes again while the person reads the diff.
    api.__editOutside("README.md", "# Theirs\n");
    await expect(api.approve(looked, "")).rejects.toEqual({ code: "changed" });
    await expect(api.reject(looked)).rejects.toEqual({ code: "changed" });
    expect(await api.readDoc("README.md")).toBe("# Theirs\n");
    expect(await api.history("README.md", 50)).toHaveLength(1);
  });

  it("approve with empty message uses default", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    await api.approve(await seenOf(api, ["README.md"]), "  \n ");
    expect((await api.history("README.md", 1))[0].message).toBe("Update README.md");
    await api.writeDoc("a.md", "a");
    await api.writeDoc("b.md", "b");
    await api.approve(await seenOf(api, ["a.md", "b.md"]), "");
    expect((await api.history("a.md", 1))[0].message).toBe("Update 2 docs");
  });

  it("reject restores modified and deletes added", async () => {
    const api = await opened();
    api.__editOutside("README.md", "# Theirs\n");
    await api.writeDoc("docs/new.md", "# New\n");
    api.__editOutside("docs/xss.md", null);
    // Skips the echoes of the edits above, which arrive one path at a time.
    const seen = new Promise<string[]>((resolve) => void api.onVaultChanged((p) => p.length > 1 && resolve(p)));
    await api.reject(await seenOf(api, ["README.md", "docs/new.md", "docs/xss.md"]));
    expect(await api.readDoc("README.md")).toBe(seed["README.md"]);
    expect(await api.readDoc("docs/xss.md")).toBe(seed["docs/xss.md"]);
    await expect(api.readDoc("docs/new.md")).rejects.toEqual({ code: "not_found" });
    expect(plain(await api.listChanges())).toEqual([]);
    expect((await seen).sort()).toEqual(["README.md", "docs/new.md", "docs/xss.md"].sort());
  });

  it("history newest first and readVersion", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "v2");
    await api.approve(await seenOf(api, ["README.md"]), "two");
    await api.writeDoc("docs/kien-truc.md", "other doc");
    await api.approve(await seenOf(api, ["docs/kien-truc.md"]), "unrelated");
    await api.writeDoc("README.md", "v3");
    await api.approve(await seenOf(api, ["README.md"]), "three\n\nbody");
    const log = await api.history("README.md", 50);
    expect(log.map((c) => c.message)).toEqual(["three", "two", "Import docs"]);
    expect(await api.history("README.md", 1)).toHaveLength(1);
    expect(await api.readVersion("README.md", log[1].id)).toBe("v2");
    expect(await api.readVersion("README.md", log[2].id.slice(0, 7))).toBe(seed["README.md"]);
    expect(await api.readVersion("docs/new.md", log[0].id)).toBeNull();
    await expect(api.readVersion("README.md", "--output=x")).rejects.toMatchObject({ code: "git" });
    await expect(api.readVersion("README.md", "HEAD")).rejects.toMatchObject({ code: "git" });
  });

  it("restoreVersion creates a pending app change", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "v2");
    await api.approve(await seenOf(api, ["README.md"]), "two");
    const first = (await api.history("README.md", 50)).at(-1)!;
    await api.restoreVersion("README.md", first.id);
    expect(await api.readDoc("README.md")).toBe(seed["README.md"]);
    expect(plain(await api.listChanges())).toEqual([{ path: "README.md", kind: "modified", origin: "app", note: null }]);
    await expect(api.restoreVersion("docs/new.md", first.id)).rejects.toEqual({ code: "not_found" });
  });

  it("no repo rejects list with no_repo, initRepo makes all docs added", async () => {
    const api = createMockApi(seed, { repo: false });
    await expect(api.vcsState()).rejects.toEqual({ code: "no_vault" });
    await api.openVault("/vault");
    expect(await api.vcsState()).toEqual({ status: "no_repo" });
    await expect(api.listChanges()).rejects.toEqual({ code: "no_repo" });
    await expect(api.history("README.md", 50)).rejects.toEqual({ code: "no_repo" });
    await api.initRepo();
    expect(await api.vcsState()).toEqual({ status: "ok" });
    const changes = await api.listChanges();
    expect(changes.map((c) => c.path)).toEqual(Object.keys(seed).sort());
    expect(changes.every((c) => c.kind === "added" && c.origin === "outside")).toBe(true);
    expect(await api.history("README.md", 50)).toEqual([]);
    expect(await api.readBase("README.md")).toBeNull();
    expect(await api.approve(await seenOf(api, ["README.md"]), "")).toMatch(/^[0-9a-f]{40}$/);
    expect((await api.history("README.md", 50))[0].message).toBe("Add README.md");
  });

  it("toApiError keeps git codes", () => {
    for (const code of ["no_git", "no_repo", "git", "git_identity"] as const) {
      expect(toApiError({ code, detail: "x" })).toEqual({ code, detail: "x" });
    }
    expect(toApiError("boom")).toEqual({ code: "io", detail: "boom" });
    expect(toApiError({ code: "nope" })).toMatchObject({ code: "io" });
  });

  it("default message rules", () => {
    expect(defaultMessage([{ path: "n.md", kind: "added", origin: "app", note: null, hash: null }])).toBe("Add n.md");
    expect(defaultMessage([{ path: "a.md", kind: "modified", origin: "app", note: null, hash: null }])).toBe("Update a.md");
    expect(defaultMessage([{ path: "b.md", kind: "deleted", origin: "outside", note: null, hash: null }])).toBe("Delete b.md");
  });
});

describe("mock links and export", () => {
  const vault = {
    "README.md": "# Home\n\nSee [[store]] and [[store]] and [[README]].\n",
    "arch/store.md": "---\ntitle: Store design\nagents: true\n---\n# Store\n\nIntro.\n\n## Tables\n",
    "notes/a.md": "[back](../arch/store.md) [[nope]]\n",
    "notes/claude.md": "---\nagents: [claude]\n---\nClaude only\n",
  };

  it("backlinks are unique, sorted, without the doc itself", async () => {
    const api = await opened(vault);
    expect(await api.backlinks("arch/store.md")).toEqual([
      { path: "README.md", title: "Home" },
      { path: "notes/a.md", title: "a" },
    ]);
    expect(await api.backlinks("README.md")).toEqual([]);
    await expect(createMockApi(vault).backlinks("README.md")).rejects.toEqual({ code: "no_vault" });
  });

  it("titles come from frontmatter", async () => {
    const docs = await (await opened(vault)).listDocs();
    expect(docs.find((d) => d.path === "arch/store.md")?.title).toBe("Store design");
  });

  it("exportPlan lists marked docs and renders the files", async () => {
    const api = await opened(vault);
    const plan = await api.exportPlan();
    expect(plan.root).toBe("/vault");
    expect(plan.docs).toEqual([
      { path: "arch/store.md", title: "Store design", targets: ["agents"] },
      { path: "notes/claude.md", title: "claude", targets: ["claude"] },
    ]);
    expect(plan.files.map((f) => [f.path, f.status])).toEqual([
      ["AGENTS.md", "new"],
      ["CLAUDE.md", "new"],
      ["GEMINI.md", "new"],
    ]);
    const agents = plan.files[0];
    expect(agents.old).toBeNull();
    expect(agents.new).toBe(
      `${EXPORT_MARKER}\n# Agent guide\n\n## Store design\n_Source: \`arch/store.md\`_\n\nIntro.\n\n### Tables\n`,
    );
    expect(plan.files[1].new).toBe(
      `${EXPORT_MARKER}\n# Claude Code guide\n\n@AGENTS.md\n\n## claude\n_Source: \`notes/claude.md\`_\n\nClaude only\n`,
    );
    expect(plan.files[2].new).toBe(`${EXPORT_MARKER}\n# Gemini guide\n\n@AGENTS.md\n`);
    expect(plan.tokens).toBe(Math.ceil(agents.new.length / 4));
    expect(agents.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("exportPlan renders a Cursor rule only when asked", async () => {
    const api = await opened({ "c.md": "---\nagents: cursor\n---\n# C\n" });
    const plan = await api.exportPlan();
    expect(plan.files.map((f) => f.path)).toEqual([".cursor/rules/xdev.mdc"]);
    expect(plan.files[0].new.startsWith("---\ndescription: ")).toBe(true);
    expect(plan.tokens).toBe(0);
  });

  it("exportPlan with nothing marked is empty", async () => {
    const plan = await (await opened()).exportPlan();
    expect(plan).toMatchObject({ files: [], docs: [], tokens: 0 });
  });

  it("exportWrite writes what was previewed, then reports unchanged", async () => {
    const api = await opened(vault);
    const plan = await api.exportPlan();
    const expected = plan.files.map(({ path, hash }) => ({ path, hash }));
    expect(await api.exportWrite(expected)).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    const after = await api.exportPlan();
    expect(after.files.every((f) => f.status === "unchanged")).toBe(true);
    expect(after.files[0].old).toBe(after.files[0].new);
  });

  it("exportWrite rejects a stale expectation and writes nothing", async () => {
    const api = await opened(vault);
    const plan = await api.exportPlan();
    const expected = plan.files.map(({ path, hash }) => ({ path, hash }));
    await expect(api.exportWrite([{ ...expected[0], hash: "0".repeat(64) }, ...expected.slice(1)])).rejects.toEqual({
      code: "stale",
    });
    await expect(api.exportWrite(expected.slice(1))).rejects.toEqual({ code: "stale" });
    await api.writeDoc("arch/store.md", "---\nagents: true\n---\n# Store\n\nChanged.\n");
    await expect(api.exportWrite(expected)).rejects.toEqual({ code: "stale" });
    expect((await api.exportPlan()).files.every((f) => f.status === "new")).toBe(true);
  });

  it("a hand-written file is foreign and never written", async () => {
    const api = createMockApi(vault, { exported: { "CLAUDE.md": "# My own rules\n" } });
    await api.openVault("/vault");
    const plan = await api.exportPlan();
    expect(plan.files[1]).toMatchObject({ path: "CLAUDE.md", status: "foreign", old: "# My own rules\n" });
    const expected = plan.files.filter((f) => f.status === "new").map(({ path, hash }) => ({ path, hash }));
    expect(await api.exportWrite(expected)).toEqual(["AGENTS.md", "GEMINI.md"]);
    expect((await api.exportPlan()).files[1].old).toBe("# My own rules\n");
  });

  it("a generated file that differs is changed", async () => {
    const api = createMockApi(vault, { exported: { "GEMINI.md": `${EXPORT_MARKER}\n# Old\n` } });
    await api.openVault("/vault");
    expect((await api.exportPlan()).files[2].status).toBe("changed");
  });

  it("demo seed shows links and an export", async () => {
    const api = await opened(DEMO_SEED);
    const backlinks = await api.backlinks("docs/architecture/tai-lieu-kien-truc.md");
    expect(backlinks.map((l) => l.path)).toEqual(["notes/2026/hop-giao-ban.md"]);
    expect((await api.backlinks("docs/architecture/decisions.md")).map((l) => l.path)).toEqual([
      "README.md",
      "docs/architecture/tai-lieu-kien-truc.md",
    ]);
    const plan = await api.exportPlan();
    expect(plan.files.map((f) => f.path)).toEqual(["AGENTS.md", "CLAUDE.md", "GEMINI.md"]);
    expect(plan.docs.map((d) => d.title)).toContain("Tài liệu kiến trúc");
  });

  it("toApiError keeps stale", () => {
    expect(toApiError({ code: "stale" })).toEqual({ code: "stale" });
  });
});

describe("mock freshness", () => {
  const ids = { a: "a".repeat(40), b: "b".repeat(40), c: "c".repeat(40) };
  const commits: SeedCommit[] = [
    { id: ids.a, author: "Linh", ago: 300, message: "Base", touched: ["src/lib.rs"] },
    { id: ids.b, author: "Minh", ago: 200, message: "Touch the store", touched: ["src/store/db.rs"] },
    { id: ids.c, author: "Linh", ago: 100, message: "Touch the cli", touched: ["cli/main.rs"] },
  ];
  const vault = {
    "plain.md": "# Plain\n",
    "never.md": "---\ncovers: src\n---\n# Never\n",
    "store.md": "---\ncovers: [src/store/**]\nverified: AAAAAAA\n---\n# Store\n",
    "cli.md": "---\ncovers: [cli/*.rs]\nverified: bbbbbbb\n---\n# Cli\n",
    "lost.md": "---\ncovers: src\nverified: 0123abcd\n---\n# Lost\n",
  };

  async function vaultApi(repo = true) {
    const api = createMockApi(vault, { repo, commits });
    await api.openVault("/vault");
    return api;
  }

  it("gives none, unverified, stale, fresh and unknown", async () => {
    const api = await vaultApi();
    const head = (await api.docFreshness("plain.md")).head;
    expect(head).toBe(ids.c);
    expect(await api.docFreshness("plain.md")).toEqual({
      state: "none",
      covers: [],
      verified: null,
      head,
      commits: [],
      count: 0,
    });
    expect(await api.docFreshness("never.md")).toMatchObject({ state: "unverified", covers: ["src"], verified: null });
    const store = await api.docFreshness("store.md");
    expect(store).toMatchObject({ state: "stale", verified: "aaaaaaa", count: 1 });
    expect(store.commits).toEqual([{ id: ids.b, author: "Minh", time: expect.any(Number), message: "Touch the store" }]);
    expect(await api.docFreshness("cli.md")).toMatchObject({ state: "stale", count: 1 });
    expect(await api.docFreshness("lost.md")).toMatchObject({ state: "unknown", commits: [], count: 0 });
  });

  it("lists commits newest first and counts them all", async () => {
    const many: SeedCommit[] = Array.from({ length: 25 }, (_, i) => ({
      id: (i + 1).toString(16).padStart(40, "0"),
      author: "Linh",
      ago: 1000 - i,
      message: `Change ${i}`,
      touched: [`src/f${i}.rs`],
    }));
    const api = createMockApi({ "d.md": `---\ncovers: src\nverified: ${many[0].id}\n---\n` }, { commits: many });
    await api.openVault("/vault");
    const fresh = await api.docFreshness("d.md");
    expect(fresh).toMatchObject({ state: "stale", count: 24 });
    expect(fresh.commits).toHaveLength(20);
    expect(fresh.commits[0].message).toBe("Change 24");
  });

  it("saving verified at head makes the doc fresh", async () => {
    const api = await vaultApi();
    const { head } = await api.docFreshness("store.md");
    await api.writeDoc("store.md", setVerified(await api.readDoc("store.md"), head!));
    expect(await api.docFreshness("store.md")).toMatchObject({ state: "fresh", verified: head, commits: [], count: 0 });
  });

  it("without git, covered docs are unknown or unverified and there is no head", async () => {
    const api = await vaultApi(false);
    expect(await api.docFreshness("store.md")).toMatchObject({ state: "unknown", head: null });
    expect(await api.docFreshness("never.md")).toMatchObject({ state: "unverified", head: null });
  });

  it("rejects bad paths", async () => {
    const api = await vaultApi();
    await expect(createMockApi(vault).docFreshness("plain.md")).rejects.toEqual({ code: "no_vault" });
    await expect(api.docFreshness("../x.md")).rejects.toEqual({ code: "outside_vault" });
    await expect(api.docFreshness("nope.md")).rejects.toEqual({ code: "not_found" });
  });

  it("staleDocs lists problem docs only", async () => {
    const api = await vaultApi();
    expect(await api.staleDocs()).toEqual([
      { path: "cli.md", title: "Cli", state: "stale", count: 1 },
      { path: "lost.md", title: "Lost", state: "unknown", count: 0 },
      { path: "never.md", title: "Never", state: "unverified", count: 0 },
      { path: "store.md", title: "Store", state: "stale", count: 1 },
    ]);
    await expect(createMockApi(vault).staleDocs()).rejects.toEqual({ code: "no_vault" });
  });

  it("covers match like git glob pathspecs", () => {
    const store = coverMatcher("crates/store/**");
    expect(store("crates/store/src/lib.rs")).toBe(true);
    expect(store("crates/storage/lib.rs")).toBe(false);
    const folder = coverMatcher("src");
    expect(folder("src")).toBe(true);
    expect(folder("src/a/b.rs")).toBe(true);
    expect(folder("srcx/a.rs")).toBe(false);
    const star = coverMatcher("src/*.rs");
    expect(star("src/a.rs")).toBe(true);
    expect(star("src/a/b.rs")).toBe(false);
    const any = coverMatcher("**/schema.sql");
    expect(any("schema.sql")).toBe(true);
    expect(any("db/v1/schema.sql")).toBe(true);
    expect(coverMatcher("a.b")("axb")).toBe(false);
  });

  it("demo seed has a stale and an unverified doc", async () => {
    expect(DEMO_COMMITS.every((c) => /^[0-9a-f]{40}$/.test(c.id))).toBe(true);
    const api = createMockApi(DEMO_SEED, { commits: DEMO_COMMITS });
    await api.openVault("/demo");
    expect(await api.staleDocs()).toEqual([
      { path: "docs/architecture/store.md", title: "Store design", state: "stale", count: 3 },
      { path: "docs/architecture/vault.md", title: "Vault", state: "unverified", count: 0 },
    ]);
  });
});

describe("mock ai proposals", () => {
  it("shows an ai change with its note until approved", async () => {
    const api = await opened();
    api.__propose("README.md", "# Proposed\n", "Shorter intro.");
    api.__propose("docs/new.md", "# New\n", null);
    expect(plain(await api.listChanges())).toEqual([
      { path: "README.md", kind: "modified", origin: "ai", note: "Shorter intro." },
      { path: "docs/new.md", kind: "added", origin: "ai", note: null },
    ]);
    // The agent may revise its own proposal.
    api.__propose("README.md", "# Proposed again\n", "Second try.");
    expect((await api.listChanges())[0]).toMatchObject({ origin: "ai", note: "Second try." });
    await api.approve(await seenOf(api, ["README.md"]), "");
    await api.reject(await seenOf(api, ["docs/new.md"]));
    expect(plain(await api.listChanges())).toEqual([]);
  });

  it("refuses over a person's pending edit and without git", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    expect(() => api.__propose("README.md", "# Agent\n", null)).toThrow(expect.objectContaining({ code: "conflict" }));
    expect(await api.readDoc("README.md")).toBe("# Mine\n");
    const plain = createMockApi(seed, { repo: false });
    await plain.openVault("/vault");
    expect(() => plain.__propose("README.md", "x", null)).toThrow(expect.objectContaining({ code: "no_repo" }));
  });

  it("an app write of the same text counts as the app's", async () => {
    const api = await opened();
    api.__propose("README.md", "# Same\n", "note");
    await api.writeDoc("README.md", "# Same\n");
    expect(plain(await api.listChanges())).toEqual([{ path: "README.md", kind: "modified", origin: "app", note: null }]);
  });

  it("toApiError keeps conflict", () => {
    expect(toApiError({ code: "conflict", detail: "x" })).toEqual({ code: "conflict", detail: "x" });
  });
});


describe("accounts mock contract", () => {
  it("provides quota samples independently of a vault", async () => {
    const api = createMockApi({});
    expect((await api.accounts()).reservePercent).toBe(30);
    expect((await api.quota()).map(q => [q.name, q.state])).toEqual([["claude-2", "ok"], ["claude-3", "reserve"], ["old", "unknown"], ["codex-1", "ok"]]);
    expect((await api.quota())[0].windows.map(w => w.utilization)).toEqual([12, 40]);
    expect((await api.accounts()).accounts.map(a => a.provider)).toEqual(["claude", "claude", "claude", "codex"]);
    const quotas = await api.quota();
    expect(quotas.filter(q => q.asOf !== null).map(q => q.name)).toEqual(["codex-1"]);
  });
  it("validates, adds, logs in and unregisters", async () => {
    const api = createMockApi({});
    for (const name of ["", "A b", "-a", "a\n", "a".repeat(33)]) await expect(api.addAccount(name, "claude")).rejects.toEqual({ code: "bad_name" });
    await expect(api.addAccount("old", "claude")).rejects.toEqual({ code: "exists" });
    await expect(api.addAccount("g", "gemini" as never)).rejects.toEqual({ code: "unknown_provider" });
    const added = await api.addAccount("new-1", "claude");
    expect(added.status.state).toBe("logged_out");
    expect((await api.loginAccount(added.name)).command).toContain(added.dir);
    const codex = await api.addAccount("new-2", "codex");
    expect(codex.provider).toBe("codex");
    expect((await api.loginAccount(codex.name)).command).toBe(`CODEX_HOME='${codex.dir}' codex login`);
    await api.removeAccount(added.name);
    await expect(api.loginAccount(added.name)).rejects.toEqual({ code: "not_found" });
    await expect(api.removeAccount(added.name)).rejects.toEqual({ code: "not_found" });
  });
  it("preserves account error codes", () => {
    for (const code of ["bad_name", "exists", "not_found", "no_claude", "no_codex", "unknown_provider", "bad_registry", "bad_reserve"]) expect(toApiError({ code })).toEqual({ code });
  });
});

it("routes account calls through Tauri and normalizes their errors", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.accounts(); await api.quota(); await api.addAccount("new", "codex"); await api.loginAccount("new"); await api.removeAccount("new");
    const routing = { rules: [{ role: "review", provider: null, maxPrompt: 800, model: "haiku" }] };
    await api.routing(); await api.setRouting(routing); await api.models();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["accounts_list", undefined], ["accounts_quota", undefined],
      ["account_add", { name: "new", provider: "codex", dir: null }], ["account_login", { name: "new" }], ["account_remove", { name: "new" }],
      ["routing_get", undefined], ["routing_set", { routing }], ["routing_models", undefined],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce({ code: "bad_registry" });
    await expect(api.accounts()).rejects.toEqual({ code: "bad_registry" });
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("routes pull request, project, issue create and create request calls with the names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    const query = { state: "merged" as const, mine: true, needsReview: false, search: null, limit: 20 };
    const draft = { title: "T", body: "B" };
    await api.prsList("r", query); await api.prGet("r", 7); await api.prOpen("r", 7); await api.prBranch("r", 7); await api.prBranchDiscard("r", "pr-7");
    await api.projectsList("r"); await api.projectOpen("r", 2); await api.issueCreate("r", draft);
    await api.worktreeCreate("r", "n", null); await api.worktreeCreate("r", "n", "main", { existing: "b", sparse: ["src"] });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["prs_list", { repoId: "r", query }], ["pr_get", { repoId: "r", number: 7 }], ["pr_open", { repoId: "r", number: 7 }],
      ["pr_branch", { repoId: "r", number: 7 }], ["pr_branch_discard", { repoId: "r", branch: "pr-7" }], ["projects_list", { repoId: "r" }], ["project_open", { repoId: "r", number: 2 }],
      ["issue_create", { repoId: "r", draft }],
      ["worktree_create", { repoId: "r", name: "n", from: null, request: null }],
      ["worktree_create", { repoId: "r", name: "n", from: "main", request: { existing: "b", sparse: ["src"] } }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("routes shell and update calls through Tauri with the argument names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    const settings = { minimizeToTray: true, menuBarIcon: true, trayNoticeShown: false, updateChannel: "rc" as const };
    await api.shellSettings(); await api.shellSettingsPut(settings);
    await api.shellCloseRequested("xDev", "Still running"); await api.shellQuit("end-all"); await api.shellQuitCancelled();
    await api.helpOpen("docs"); await api.trayAttention(); await api.windowReload(); await api.windowDevtoolsToggle();
    await api.updateCheck(true); await api.updatePhase();
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["shell_settings_get", undefined], ["shell_settings_put", { settings }],
      ["shell_close_requested", { noticeTitle: "xDev", noticeBody: "Still running" }], ["shell_quit", { mode: "end-all" }], ["shell_quit_cancelled", undefined],
      ["help_open", { link: "docs" }], ["tray_attention", undefined], ["window_reload", undefined], ["window_devtools_toggle", undefined],
      ["update_check", { rc: true }], ["update_phase", undefined],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("sends the docs folder of a repo update to Tauri as docsDir", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.repoUpdate("r1", { docsDir: "handbook" });
    await api.repoUpdate("r1", { docsDir: "" });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["repo_update", { id: "r1", patch: { docsDir: "handbook" } }],
      ["repo_update", { id: "r1", patch: { docsDir: "" } }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("routes agent kit calls through Tauri with the argument names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    const calls = () => vi.mocked(invoke).mock.calls;
    const last = () => calls()[calls().length - 1];

    await api.kitHomes();
    expect(last()).toEqual(["kit_homes", undefined]);
    await api.kitSkills("/wt");
    expect(last()).toEqual(["kit_skills", { worktree: "/wt" }]);
    await api.kitSkills(null);
    expect(last()).toEqual(["kit_skills", { worktree: null }]);
    await api.kitMemory("/wt");
    expect(last()).toEqual(["kit_memory", { worktree: "/wt" }]);
    await api.kitRead("/a/CLAUDE.md", "/wt");
    expect(last()).toEqual(["kit_read", { path: "/a/CLAUDE.md", worktree: "/wt" }]);
    await api.kitWrite("/a/CLAUDE.md", "text", "stamp", null);
    expect(last()).toEqual(["kit_write", { path: "/a/CLAUDE.md", text: "text", stamp: "stamp", worktree: null }]);
    await api.kitWrite("/a/new.md", "text", null, "/wt");
    expect(last()).toEqual(["kit_write", { path: "/a/new.md", text: "text", stamp: null, worktree: "/wt" }]);
    await api.kitCopy("/a/x.md", "/b/x.md", null);
    expect(last()).toEqual(["kit_copy", { from: "/a/x.md", to: "/b/x.md", worktree: null }]);
    await api.kitSkillCopy("/a/skills/s", "/b/skills", "/wt");
    expect(last()).toEqual(["kit_skill_copy", { dir: "/a/skills/s", toSkillsDir: "/b/skills", worktree: "/wt" }]);
    await api.kitSkillNew("/a/skills", "name", "one line", null);
    expect(last()).toEqual(["kit_skill_new", { skillsDir: "/a/skills", name: "name", description: "one line", worktree: null }]);
    await api.kitSkillRemove("/a/skills/s", null);
    expect(last()).toEqual(["kit_skill_remove", { dir: "/a/skills/s", worktree: null }]);
    await api.kitSkillRestore("/data/kit/removed/1/s", "/a/skills/s", null);
    expect(last()).toEqual(["kit_skill_restore", { removed: "/data/kit/removed/1/s", to: "/a/skills/s", worktree: null }]);
    // The local offset is added here, so callers keep the three-argument form. `getTimezoneOffset`
    // is UTC minus local, so UTC+7 gives -420 and the command must get 420 (UTC-5 gives 300 and -300).
    const zone = vi.spyOn(Date.prototype, "getTimezoneOffset");
    try {
      zone.mockReturnValue(-420);
      await api.kitUsage("2026-11-01", "2026-11-07", true);
      expect(last()).toEqual(["kit_usage", { sinceDay: "2026-11-01", untilDay: "2026-11-07", refresh: true, utcOffsetMinutes: 420 }]);
      zone.mockReturnValue(300);
      await api.kitUsage("2026-11-01", "2026-11-07", false);
      expect(last()).toEqual(["kit_usage", { sinceDay: "2026-11-01", untilDay: "2026-11-07", refresh: false, utcOffsetMinutes: -300 }]);
      zone.mockReturnValue(0);
      await api.kitUsage("2026-11-01", "2026-11-07", false);
      // `-0` is sent as `0`; adding 0 makes the check about the number, not the sign of zero.
      expect((last()?.[1] as { utcOffsetMinutes: number }).utcOffsetMinutes + 0).toBe(0);
    } finally {
      zone.mockRestore();
    }
    await api.kitPathsExist("/wt", ["a.md", "b/c.md"]);
    expect(last()).toEqual(["kit_paths_exist", { root: "/wt", paths: ["a.md", "b/c.md"] }]);
    await api.kitPromptHistory(50);
    expect(last()).toEqual(["kit_prompt_history", { limit: 50 }]);
    expect(calls()).toHaveLength(17);

    vi.mocked(invoke).mockRejectedValueOnce({ code: "outside" });
    await expect(api.kitRead("/x", null)).rejects.toEqual({ code: "outside" });
    vi.mocked(invoke).mockRejectedValueOnce({ code: "changed" });
    await expect(api.kitWrite("/x", "t", "s", null)).rejects.toEqual({ code: "changed" });
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

describe("mock agent kit", () => {
  it("has two homes, four skills with one duplicate, one stale memory line and seven days of usage", async () => {
    const api = createMockApi({});
    expect((await api.kitHomes()).map((h) => h.agent)).toEqual(["claude", "codex"]);
    const skills = await api.kitSkills(null);
    expect(skills).toHaveLength(4);
    expect(skills.filter((s) => s.duplicate)).toHaveLength(2);
    const memory = await api.kitMemory(null);
    expect(memory.files.flatMap((f) => f.issues)).toHaveLength(1);
    const usage = await api.kitUsage("2026-11-01", "2026-11-07", false);
    expect(usage.days).toHaveLength(7);
  });

  it("saves with a stamp and refuses a stale one with changed", async () => {
    const api = createMockApi({});
    const [file] = (await api.kitMemory(null)).files;
    const read = await api.kitRead(file.path, null);
    const next = await api.kitWrite(file.path, "new text", read.stamp, null);
    expect(next).not.toBe(read.stamp);
    expect((await api.kitRead(file.path, null)).text).toBe("new text");
    await expect(api.kitWrite(file.path, "again", read.stamp, null)).rejects.toEqual({ code: "changed" });
    // Like Rust: a file that is not there is an `io` error, not `not_found`.
    await expect(api.kitRead("/demo/home/.claude/gone.md", null)).rejects.toMatchObject({ code: "io" });
  });

  it("creates, copies, removes and restores a skill", async () => {
    const api = createMockApi({});
    const [home] = await api.kitHomes();
    const skillsDir = `${home.path}/skills`;
    const file = await api.kitSkillNew(skillsDir, "fresh", "A new one", null);
    expect(file).toBe(`${skillsDir}/fresh/SKILL.md`);
    expect((await api.kitSkills(null)).map((s) => s.name)).toContain("fresh");
    const removed = await api.kitSkillRemove(`${skillsDir}/fresh`, null);
    expect((await api.kitSkills(null)).map((s) => s.name)).not.toContain("fresh");
    await api.kitSkillRestore(removed, `${skillsDir}/fresh`, null);
    expect((await api.kitSkills(null)).map((s) => s.name)).toContain("fresh");
  });

  // Each case is what the Rust command answers for the same call (xdev-kit write.rs), so a view
  // built against the mock branches on codes the real app returns.
  it("rejects with the codes Rust uses", async () => {
    const api = createMockApi({});
    const [home, other] = await api.kitHomes();
    const skillsDir = `${home.path}/skills`;
    // Name rule of `xdev_ai::valid_name`: 1 to 32 of a-z, 0-9 and "-", no leading "-".
    await api.kitSkillNew(skillsDir, "a".repeat(32), "limit", null);
    for (const name of ["Bad Name", "", "-lead", "a".repeat(33)]) {
      await expect(api.kitSkillNew(skillsDir, name, "x", null)).rejects.toMatchObject({ code: "bad_name" });
    }
    await expect(api.kitSkillNew(skillsDir, "two-lines", "a\nb", null)).rejects.toMatchObject({ code: "kit_bad_input" });
    await expect(api.kitSkillNew("/elsewhere/skills", "fine", "x", null)).rejects.toMatchObject({ code: "outside" });
    // A name that is taken is `changed` (a write with no stamp over a file), not `exists`.
    await api.kitSkillNew(skillsDir, "taken", "x", null);
    await expect(api.kitSkillNew(skillsDir, "taken", "x", null)).rejects.toEqual({ code: "changed" });
    // A folder under a root that is not a skill is `kit_bad_input`; one outside every root is `outside`.
    await expect(api.kitSkillRemove(`${skillsDir}/nothing-here`, null)).rejects.toMatchObject({ code: "kit_bad_input" });
    await expect(api.kitSkillRemove("/elsewhere/skills/x", null)).rejects.toMatchObject({ code: "outside" });
    await expect(api.kitSkillCopy(`${skillsDir}/nothing-here`, `${other.path}/skills`, null)).rejects.toMatchObject({ code: "kit_bad_input" });
    await expect(api.kitSkillCopy(`${skillsDir}/taken`, "/elsewhere/skills", null)).rejects.toMatchObject({ code: "outside" });
    await api.kitSkillCopy(`${skillsDir}/taken`, `${other.path}/skills`, null);
    await expect(api.kitSkillCopy(`${skillsDir}/taken`, `${other.path}/skills`, null)).rejects.toEqual({ code: "changed" });
    // Restore: a folder outside the removed area is `outside`; one inside it that is gone (already
    // restored) is `kit_bad_input`; a taken target is `changed`.
    const removed = await api.kitSkillRemove(`${skillsDir}/taken`, null);
    await expect(api.kitSkillRestore("/elsewhere/removed/taken", `${skillsDir}/taken`, null)).rejects.toMatchObject({ code: "outside" });
    await api.kitSkillNew(skillsDir, "taken", "again", null);
    await expect(api.kitSkillRestore(removed, `${skillsDir}/taken`, null)).rejects.toEqual({ code: "changed" });
    await api.kitSkillRestore(removed, `${skillsDir}/back`, null);
    await expect(api.kitSkillRestore(removed, `${skillsDir}/again`, null)).rejects.toMatchObject({ code: "kit_bad_input" });
    await expect(api.kitSkills("/not/a/worktree")).rejects.toMatchObject({ code: "outside" });
  });

  it("flags a duplicate only for one name with different bytes", async () => {
    const api = createMockApi({});
    const [home, other] = await api.kitHomes();
    const reviews = (await api.kitSkills(null)).filter((s) => s.name === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0].hash).not.toBe(reviews[1].hash);
    expect(reviews.every((s) => s.duplicate)).toBe(true);
    // The same bytes in two homes are one skill, not a conflict.
    const made = await api.kitSkillCopy(`${home.path}/skills/release-notes`, `${other.path}/skills`, null);
    const notes = (await api.kitSkills(null)).filter((s) => s.name === "release-notes");
    expect(made).toBe(`${other.path}/skills/release-notes`);
    expect(notes).toHaveLength(2);
    expect(notes[0].hash).toBe(notes[1].hash);
    expect(notes.some((s) => s.duplicate)).toBe(false);
  });

  it("reports which relative paths exist and gives a prompt history", async () => {
    const api = createMockApi({});
    const got = await api.kitPathsExist("/demo/xdev", ["README.md", "gone.md"]);
    expect(got).toEqual([true, false]);
    const history = await api.kitPromptHistory(2);
    expect(history).toHaveLength(2);
    expect(history[0].at).toBeGreaterThanOrEqual(history[1].at);
  });
});

it("routes the branch update and history calls through Tauri with the argument names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.worktreeFastForward("/wt");
    await api.worktreeRebaseFromBase("/wt");
    await api.worktreeLog("/wt", 50, 0);
    await api.worktreeCommitFiles("/wt", "abc1234");
    await api.worktreeCommitFile("/wt", "abc1234", "src/a.ts");
    await api.worktreeOpenCommit("/wt", "abc1234");
    await api.worktreeOpenFileOnHost("/wt", "src/a.ts", null, null);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["worktree_fast_forward", { path: "/wt" }],
      ["worktree_rebase_from_base", { path: "/wt" }],
      ["worktree_log", { path: "/wt", limit: 50, skip: 0 }],
      ["worktree_commit_files", { path: "/wt", id: "abc1234" }],
      ["worktree_commit_file", { path: "/wt", id: "abc1234", file: "src/a.ts" }],
      ["worktree_open_commit", { path: "/wt", id: "abc1234" }],
      ["worktree_open_file_on_host", { path: "/wt", file: "src/a.ts", line: null, endLine: null }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("sends the fork flag and the keep awake calls to Tauri, null when absent", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined), Channel: class { onmessage: unknown } }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.ptyApprove("claude", null);
    await api.ptyApprove("claude", null, "s1", true);
    await api.ptyApprove("claude", null, undefined, undefined, ["--model", "opus"]);
    await api.keepAwake(); await api.keepAwakeSet("agent"); await api.keepAwakeAgents(true);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["pty_approve", { profileId: "claude", account: null, resume: null, fork: null, extraArgs: null }],
      ["pty_approve", { profileId: "claude", account: null, resume: "s1", fork: true, extraArgs: null }],
      ["pty_approve", { profileId: "claude", account: null, resume: null, fork: null, extraArgs: ["--model", "opus"] }],
      ["keep_awake_get", undefined], ["keep_awake_set", { mode: "agent" }], ["keep_awake_agents", { working: true }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("routes pull request review calls with the names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    const draft = { body: "b", replyTo: null, path: null, line: null, startLine: null, commit: null };
    await api.worktreePrComments("/w", 7); await api.worktreePrCommentPost("/w", 7, draft);
    await api.worktreePrHead("/w", 7); await api.worktreePrThreadResolve("/w", "T1", true); await api.worktreePrReaction("/w", "N1", "THUMBS_UP", false);
    await api.worktreePrChecksRerun("/w", 7, true); await api.worktreePrMergeInfo("/w", 7); await api.worktreePrMerge("/w", 7, "squash", "abc");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["worktree_pr_comments", { path: "/w", number: 7 }], ["worktree_pr_comment_post", { path: "/w", number: 7, draft }],
      ["worktree_pr_head", { path: "/w", number: 7 }],
      ["worktree_pr_thread_resolve", { path: "/w", threadId: "T1", resolved: true }],
      ["worktree_pr_reaction", { path: "/w", subjectId: "N1", content: "THUMBS_UP", on: false }],
      ["worktree_pr_checks_rerun", { path: "/w", number: 7, failedOnly: true }],
      ["worktree_pr_merge_info", { path: "/w", number: 7 }], ["worktree_pr_merge", { path: "/w", number: 7, method: "squash", headOid: "abc" }],
    ]);
    vi.mocked(invoke).mockRejectedValueOnce({ code: "merge_blocked", detail: "draft" });
    await expect(api.worktreePrMerge("/w", 7, "merge", "abc")).rejects.toEqual({ code: "merge_blocked", detail: "draft" });
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("sends the port calls to Tauri with the worktrees and the id", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined), Channel: class { onmessage: unknown } }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.portsScan(["/w/a"], true);
    await api.portsStop(["/w/a"], "localhost:5173:42", { confirmed: true, outsideTerminal: false });
    await api.portsOpen("localhost:5173:42");
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["ports_scan", { worktrees: ["/w/a"], force: true }],
      ["ports_stop", { worktrees: ["/w/a"], id: "localhost:5173:42", confirmed: true, outsideTerminal: false }],
      ["ports_open", { id: "localhost:5173:42" }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

it("routes terminal link calls through Tauri with the argument names Rust expects", async () => {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined) }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.fileLinksResolve("/wt", ["a.ts"]);
    await api.fileLinksResolve("/wt", ["a.ts"], "/wt/pkg");
    await api.fileOpenDefault("/wt", "a.ts");
    await api.openUrl("https://x.dev");
    await api.fileRemoteUrl("/wt", "a.ts", 3, null);
    await api.fileRemoteUrl("/wt", "a.ts", 3, 5);
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["file_links_resolve", { worktree: "/wt", paths: ["a.ts"] }],
      ["file_links_resolve", { worktree: "/wt", paths: ["a.ts"], cwd: "/wt/pkg" }],
      ["file_open_default", { worktree: "/wt", rel: "a.ts" }],
      ["open_url", { url: "https://x.dev" }],
      ["file_remote_url", { worktree: "/wt", rel: "a.ts", line: 3, endLine: null }],
      ["file_remote_url", { worktree: "/wt", rel: "a.ts", line: 3, endLine: 5 }],
    ]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.resetModules(); }
});

describe("mock provider keys", () => {
  const KEY = "test-placeholder";

  it("aiKeys lists three providers unsaved by default", async () => {
    const api = createMockApi(seed);
    expect(await api.aiKeys()).toEqual([
      { provider: "anthropic", saved: false },
      { provider: "openai", saved: false },
      { provider: "gemini", saved: false },
    ]);
  });

  it("aiKeySet then aiKeys shows saved and never returns the key", async () => {
    const api = createMockApi(seed);
    await api.aiKeySet("openai", `  ${KEY} `);
    const rows = await api.aiKeys();
    expect(rows.find((r) => r.provider === "openai")?.saved).toBe(true);
    expect(JSON.stringify(rows)).not.toContain(KEY);
  });

  it("aiKeySet rejects blank, too long and unknown", async () => {
    const api = createMockApi(seed);
    await expect(api.aiKeySet("openai", "   ")).rejects.toMatchObject({ code: "empty_key" });
    await expect(api.aiKeySet("openai", "a".repeat(4097))).rejects.toMatchObject({ code: "too_large" });
    await expect(api.aiKeySet("other" as AiKeyProvider, KEY)).rejects.toMatchObject({ code: "unknown_provider" });
    await api.aiKeySet("openai", "a".repeat(4096));
    expect((await api.aiKeys()).find((r) => r.provider === "openai")?.saved).toBe(true);
  });

  it("aiKeyRemove returns true then false", async () => {
    const api = createMockApi(seed);
    await api.aiKeySet("anthropic", KEY);
    expect(await api.aiKeyRemove("anthropic")).toBe(true);
    expect(await api.aiKeyRemove("anthropic")).toBe(false);
    expect((await api.aiKeys()).every((r) => !r.saved)).toBe(true);
  });

  it("seed aiKeys starts those providers saved", async () => {
    const api = createMockApi(seed, { aiKeys: ["gemini"] });
    const saved = (await api.aiKeys()).filter((r) => r.saved).map((r) => r.provider);
    expect(saved).toEqual(["gemini"]);
    expect(AI_KEY_PROVIDERS).toHaveLength(3);
  });
});

it("routes automation calls and events to their Tauri names", async () => {
  vi.resetModules();
  const listen = vi.fn().mockResolvedValue(() => {});
  vi.doMock("@tauri-apps/api/core", () => ({ invoke: vi.fn().mockResolvedValue(undefined), Channel: class {} }));
  vi.doMock("@tauri-apps/api/event", () => ({ listen }));
  vi.stubGlobal("window", { __TAURI_INTERNALS__: {} });
  try {
    const { api } = await import("./api");
    const { invoke } = await import("@tauri-apps/api/core");
    await api.automationsList(); await api.automationRuns("a"); await api.automationSetEnabled("a", false); await api.automationDelete("a");
    await api.automationRunNow("a"); await api.automationDescribe("0 * * * *", "UTC"); await api.automationValidateSchedule("0 * * * *", "UTC");
    await api.automationNextRuns("0 * * * *", "UTC", 5, 3); await api.automationUiReady(); await api.automationsSettings();
    await api.automationRunFinish({ runId: "r", completed: true, output: null, truncated: false });
    await api.automationDispatchResult({ status: "dispatched", runId: "r", tabId: "t" });
    expect(vi.mocked(invoke).mock.calls).toEqual([
      ["automations_list", undefined], ["automation_runs", { automationId: "a" }], ["automation_set_enabled", { id: "a", enabled: false }],
      ["automation_delete", { id: "a" }], ["automation_run_now", { id: "a" }], ["automation_describe", { expr: "0 * * * *", timezone: "UTC" }],
      ["automation_validate_schedule", { expr: "0 * * * *", timezone: "UTC" }], ["automation_next_runs", { expr: "0 * * * *", timezone: "UTC", dtstart: 5, count: 3 }],
      ["automation_ui_ready", undefined], ["automations_settings_get", undefined],
      ["automation_run_finish", { finish: { runId: "r", completed: true, output: null, truncated: false } }],
      ["automation_dispatch_result", { result: { status: "dispatched", runId: "r", tabId: "t" } }],
    ]);
    await api.onAutomationDispatch(() => {}); await api.onAutomationsChanged(() => {});
    expect(listen.mock.calls.map((c) => c[0])).toEqual(["automation://dispatch", "automations://changed"]);
  } finally { vi.unstubAllGlobals(); vi.doUnmock("@tauri-apps/api/core"); vi.doUnmock("@tauri-apps/api/event"); vi.resetModules(); }
});
