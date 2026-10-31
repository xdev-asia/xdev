import { describe, expect, it } from "vitest";
import { toApiError } from "./api";
import { createMockApi, defaultMessage, DEMO_SEED, EXPORT_MARKER } from "./mockApi";

const seed = {
  "README.md": "# Hello\n\nWelcome to the vault.\n",
  "docs/kien-truc.md": "# Tài liệu kiến trúc\n\nHệ thống gồm ba lớp.\n",
  "docs/xss.md": "# Unsafe\n\n<img onerror=x> kiến trúc & more\n",
};

async function opened(files: Record<string, string> = seed) {
  const api = createMockApi(files);
  await api.openVault("/vault");
  return api;
}

describe("mock api", () => {
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
    expect(await api.listChanges()).toEqual([]);
    await api.writeDoc("README.md", "# Mine\n");
    api.__editOutside("docs/kien-truc.md", "# Theirs\n");
    api.__editOutside("docs/xss.md", null);
    await api.writeDoc("docs/new.md", "# New\n");
    // Sorted by code unit, like the Rust side, so upper case comes first.
    expect(await api.listChanges()).toEqual([
      { path: "README.md", kind: "modified", origin: "app" },
      { path: "docs/kien-truc.md", kind: "modified", origin: "outside" },
      { path: "docs/new.md", kind: "added", origin: "app" },
      { path: "docs/xss.md", kind: "deleted", origin: "outside" },
    ]);
    // Another program touching a file xDev wrote takes it over.
    api.__editOutside("README.md", "# Theirs now\n");
    expect((await api.listChanges()).find((c) => c.path === "README.md")?.origin).toBe("outside");
  });

  it("approve commits and clears", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    api.__editOutside("docs/kien-truc.md", "# Theirs\n");
    const id = await api.approve(["README.md"], "Reword the intro");
    expect(id).toMatch(/^[0-9a-f]{40}$/);
    expect(await api.listChanges()).toEqual([{ path: "docs/kien-truc.md", kind: "modified", origin: "outside" }]);
    expect(await api.readBase("README.md")).toBe("# Mine\n");
    const [latest] = await api.history("README.md", 50);
    expect(latest).toMatchObject({ id, author: "You", message: "Reword the intro" });
    expect(latest.time).toBeGreaterThan(0);
    // Stale or crafted paths are ignored.
    expect(await api.approve(["README.md", "zzz.md", "../etc.md"], "")).toBeNull();
  });

  it("approve with empty message uses default", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "# Mine\n");
    await api.approve(["README.md"], "  \n ");
    expect((await api.history("README.md", 1))[0].message).toBe("Update README.md");
    await api.writeDoc("a.md", "a");
    await api.writeDoc("b.md", "b");
    await api.approve(["a.md", "b.md"], "");
    expect((await api.history("a.md", 1))[0].message).toBe("Update 2 docs");
  });

  it("reject restores modified and deletes added", async () => {
    const api = await opened();
    api.__editOutside("README.md", "# Theirs\n");
    await api.writeDoc("docs/new.md", "# New\n");
    api.__editOutside("docs/xss.md", null);
    // Skips the echoes of the edits above, which arrive one path at a time.
    const seen = new Promise<string[]>((resolve) => void api.onVaultChanged((p) => p.length > 1 && resolve(p)));
    await api.reject(["README.md", "docs/new.md", "docs/xss.md"]);
    expect(await api.readDoc("README.md")).toBe(seed["README.md"]);
    expect(await api.readDoc("docs/xss.md")).toBe(seed["docs/xss.md"]);
    await expect(api.readDoc("docs/new.md")).rejects.toEqual({ code: "not_found" });
    expect(await api.listChanges()).toEqual([]);
    expect((await seen).sort()).toEqual(["README.md", "docs/new.md", "docs/xss.md"].sort());
  });

  it("history newest first and readVersion", async () => {
    const api = await opened();
    await api.writeDoc("README.md", "v2");
    await api.approve(["README.md"], "two");
    await api.writeDoc("docs/kien-truc.md", "other doc");
    await api.approve(["docs/kien-truc.md"], "unrelated");
    await api.writeDoc("README.md", "v3");
    await api.approve(["README.md"], "three\n\nbody");
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
    await api.approve(["README.md"], "two");
    const first = (await api.history("README.md", 50)).at(-1)!;
    await api.restoreVersion("README.md", first.id);
    expect(await api.readDoc("README.md")).toBe(seed["README.md"]);
    expect(await api.listChanges()).toEqual([{ path: "README.md", kind: "modified", origin: "app" }]);
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
    expect(await api.approve(["README.md"], "")).toMatch(/^[0-9a-f]{40}$/);
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
    expect(defaultMessage([{ path: "n.md", kind: "added", origin: "app" }])).toBe("Add n.md");
    expect(defaultMessage([{ path: "a.md", kind: "modified", origin: "app" }])).toBe("Update a.md");
    expect(defaultMessage([{ path: "b.md", kind: "deleted", origin: "outside" }])).toBe("Delete b.md");
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
