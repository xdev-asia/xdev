import { describe, expect, it } from "vitest";
import { createMockApi, DEMO_SEED } from "./mockApi";

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
