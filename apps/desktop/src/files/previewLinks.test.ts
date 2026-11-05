import { describe, expect, it, vi } from "vitest";
import { ImageCache, fillImages, isRelativeSrc, joinRel, resolveFileLink } from "./previewLinks";
import { ensureParsers, fenceLanguages } from "./parsers";

describe("joinRel and resolveFileLink", () => {
  it("joins next to the file and folds . and ..", () => {
    expect(joinRel("docs/a.md", "b.md")).toBe("docs/b.md");
    expect(joinRel("docs/a.md", "./img/x.png")).toBe("docs/img/x.png");
    expect(joinRel("docs/sub/a.md", "../b.md")).toBe("docs/b.md");
  });
  it("refuses to leave the worktree", () => {
    expect(joinRel("a.md", "../b.md")).toBeNull();
    expect(joinRel("docs/a.md", "../../b.md")).toBeNull();
  });
  it("resolves md links, a leading / from the root, and not wiki links", () => {
    expect(resolveFileLink({ kind: "md", target: "b.md" }, "docs/a.md")).toBe("docs/b.md");
    expect(resolveFileLink({ kind: "md", target: "/top.md" }, "docs/a.md")).toBe("top.md");
    expect(resolveFileLink({ kind: "wiki", target: "b" }, "docs/a.md")).toBeNull();
  });
});

describe("isRelativeSrc", () => {
  it("is false for a remote, protocol-relative, data or anchor source", () => {
    for (const src of ["https://x/a.png", "//x/a.png", "data:image/png;base64,AA", "#a", ""]) expect(isRelativeSrc(src)).toBe(false);
    expect(isRelativeSrc("img/a.png")).toBe(true);
  });
});

const el = (attrs: Record<string, string>) => ({ getAttribute: (n: string) => attrs[n] ?? null, replaceWith: vi.fn() });
const tick = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("fillImages", () => {
  it("reads a relative image through the backend, swaps it in, and revokes on cleanup", async () => {
    const image = el({ "data-src": "img/a%20b.png", "data-alt": "pic" });
    const api = { fileBytes: vi.fn(async () => new Uint8Array(2)) };
    const urls = { create: vi.fn(() => "blob:1"), revoke: vi.fn() };
    const make = vi.fn(() => "IMG");
    const stop = fillImages({ querySelectorAll: () => [image] }, { api, worktree: "W", rel: "docs/a.md", urls, make });
    await tick();
    expect(api.fileBytes).toHaveBeenCalledWith("W", "docs/img/a b.png");
    expect(make).toHaveBeenCalledWith("blob:1", "pic");
    expect(image.replaceWith).toHaveBeenCalledWith("IMG");
    stop();
    expect(urls.revoke).toHaveBeenCalledWith("blob:1");
  });
  it("reads a leading / image from the worktree root, like a link, not from the file's folder", async () => {
    const api = { fileBytes: vi.fn(async () => new Uint8Array(1)) };
    const list = [el({ "data-src": "/img/a.png" }), el({ "data-src": "/../out.png" })];
    fillImages({ querySelectorAll: () => list }, { api, worktree: "W", rel: "docs/deep/a.md", urls: { create: () => "blob:1", revoke() {} }, make: () => "IMG" });
    await tick();
    expect(api.fileBytes).toHaveBeenCalledTimes(1);
    expect(api.fileBytes).toHaveBeenCalledWith("W", "img/a.png");
  });
  it("does not read a remote image or one outside the worktree", async () => {
    const api = { fileBytes: vi.fn(async () => new Uint8Array(1)) };
    const list = [el({ "data-src": "https://x/a.png" }), el({ "data-src": "../../a.png" })];
    fillImages({ querySelectorAll: () => list }, { api, worktree: "W", rel: "a.md" });
    await tick();
    expect(api.fileBytes).not.toHaveBeenCalled();
  });
  it("drops an image that arrives after cleanup, and leaves the placeholder when the read fails", async () => {
    const late = el({ "data-src": "a.png" });
    const failed = el({ "data-src": "b.png" });
    let resolve!: (b: Uint8Array) => void;
    const api = {
      fileBytes: vi.fn((_w: string, rel: string) =>
        rel === "a.png" ? new Promise<Uint8Array>((r) => (resolve = r)) : Promise.reject({ code: "not_found" }),
      ),
    };
    const urls = { create: vi.fn(() => "blob:x"), revoke: vi.fn() };
    const stop = fillImages({ querySelectorAll: () => [late, failed] }, { api, worktree: "W", rel: "m.md", urls });
    stop();
    resolve(new Uint8Array(1));
    await tick();
    expect(urls.create).not.toHaveBeenCalled();
    expect(late.replaceWith).not.toHaveBeenCalled();
    expect(failed.replaceWith).not.toHaveBeenCalled();
  });
});

describe("ImageCache", () => {
  const deferred = () => {
    const calls: Array<{ rel: string; done: (b: Uint8Array) => void; fail: (e: unknown) => void }> = [];
    const api = {
      fileBytes: vi.fn(
        (_w: string, rel: string) => new Promise<Uint8Array>((done, fail) => calls.push({ rel, done, fail })),
      ),
    };
    return { api, calls };
  };
  const urls = () => {
    let n = 0;
    return { create: vi.fn(() => `blob:${n++}`), revoke: vi.fn() };
  };

  it("reads a path once however many images use it, and shares the URL", async () => {
    const api = { fileBytes: vi.fn(async () => new Uint8Array(1)) };
    const u = urls();
    const cache = new ImageCache(api, "W", u);
    const [a, b] = await Promise.all([cache.url("a.png"), cache.url("a.png")]);
    expect(await cache.url("a.png")).toBe(a);
    expect(b).toBe(a);
    expect(api.fileBytes).toHaveBeenCalledTimes(1);
    expect(u.create).toHaveBeenCalledTimes(1);
  });

  it("runs at most 4 reads at once and starts the next as one finishes", async () => {
    const { api, calls } = deferred();
    const cache = new ImageCache(api, "W", urls());
    const all = Array.from({ length: 7 }, (_, i) => cache.url(`${i}.png`));
    await tick();
    expect(api.fileBytes).toHaveBeenCalledTimes(4);
    calls[0].done(new Uint8Array(1));
    await tick();
    expect(api.fileBytes).toHaveBeenCalledTimes(5);
    for (const c of calls.slice(1)) c.done(new Uint8Array(1));
    await tick();
    for (const c of calls.slice(5)) c.done(new Uint8Array(1));
    await tick();
    expect(api.fileBytes).toHaveBeenCalledTimes(7);
    await expect(Promise.all(all)).resolves.toHaveLength(7);
  });

  it("does not remember a failed read, so a later call tries again", async () => {
    const api = { fileBytes: vi.fn().mockRejectedValueOnce({ code: "io" }).mockResolvedValue(new Uint8Array(1)) };
    const cache = new ImageCache(api, "W", urls());
    await expect(cache.url("a.png")).rejects.toEqual({ code: "io" });
    await expect(cache.url("a.png")).resolves.toBe("blob:0");
    expect(api.fileBytes).toHaveBeenCalledTimes(2);
  });

  it("revokes every URL on dispose and drops a read that arrives afterwards", async () => {
    const { api, calls } = deferred();
    const u = urls();
    const cache = new ImageCache(api, "W", u);
    const first = cache.url("a.png");
    calls[0].done(new Uint8Array(1));
    await first;
    const late = cache.url("b.png");
    late.catch(() => undefined);
    await tick();
    cache.dispose();
    expect(u.revoke).toHaveBeenCalledWith("blob:0");
    calls[1].done(new Uint8Array(1));
    await tick();
    expect(u.create).toHaveBeenCalledTimes(1);
    await expect(late).rejects.toThrow();
  });

  it("can be used again after dispose (a remount)", async () => {
    const api = { fileBytes: vi.fn(async () => new Uint8Array(1)) };
    const cache = new ImageCache(api, "W", urls());
    await cache.url("a.png");
    cache.dispose();
    await expect(cache.url("a.png")).resolves.toBe("blob:1");
    expect(api.fileBytes).toHaveBeenCalledTimes(2);
  });
});

describe("fillImages with a shared cache", () => {
  it("a second fill reuses the cached bytes, and its cleanup leaves the cache's URLs alone", async () => {
    const api = { fileBytes: vi.fn(async () => new Uint8Array(1)) };
    const u = { create: vi.fn(() => "blob:1"), revoke: vi.fn() };
    const cache = new ImageCache(api, "W", u);
    const make = vi.fn(() => "IMG");
    const one = el({ "data-src": "a.png" });
    fillImages({ querySelectorAll: () => [one] }, { api, worktree: "W", rel: "a.md", cache, make })();
    await tick();
    const two = el({ "data-src": "a.png" });
    const stop = fillImages({ querySelectorAll: () => [two, el({ "data-src": "a.png" })] }, { api, worktree: "W", rel: "a.md", cache, make });
    await tick();
    stop();
    expect(api.fileBytes).toHaveBeenCalledTimes(1);
    expect(two.replaceWith).toHaveBeenCalledWith("IMG");
    expect(u.revoke).not.toHaveBeenCalled();
    cache.dispose();
    expect(u.revoke).toHaveBeenCalledTimes(1);
  });
});

describe("fence languages and parsers", () => {
  it("lists the languages the fences name", () => {
    expect(fenceLanguages("```ts\nx\n```\n\n~~~rust\n~~~\n```mermaid\n```\n```\nplain\n```").sort()).toEqual(["rust", "ts"]);
  });
  it("loads a parser", async () => {
    const parsers = await ensureParsers(["json"]);
    expect(typeof parsers.json?.parse).toBe("function");
  });
});
