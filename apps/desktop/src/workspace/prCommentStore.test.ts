import { describe, expect, it, vi } from "vitest";
import { createMockApi, type Api, type PrComment } from "@/api";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { PrCommentStore } from "./prCommentStore";

const PATH = "/demo/wt/xdev-oak";

function comment(over: Partial<PrComment> = {}): PrComment {
  return {
    id: 1,
    nodeId: "N1",
    kind: "thread",
    author: "maya",
    authorBot: false,
    body: "Why?",
    createdAt: "2026-11-02T10:00:00Z",
    url: "https://x/1",
    path: "src/a.rs",
    line: 3,
    startLine: null,
    threadId: "T1",
    replyTo: null,
    resolved: false,
    outdated: false,
    diffHunk: null,
    reactions: [],
    ...over,
  };
}

function apiWith(list: PrComment[], over: Partial<Api> = {}): Api {
  const base = createMockApi({}, { workspace: { ...DEMO_WORKSPACE, prs: { [PATH]: { number: 7, url: "u", state: "open", title: "t", base: "main", head: "oak" } }, prComments: { [PATH]: list } } });
  return { ...base, ...over };
}

describe("PrCommentStore", () => {
  it("reads once while a read runs", async () => {
    const api = apiWith([comment()]);
    const spy = vi.spyOn(api, "worktreePrComments");
    const store = new PrCommentStore(api);
    await Promise.all([store.load(PATH, 7), store.load(PATH, 7)]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.get(PATH)?.comments).toHaveLength(1);
  });

  it("keeps the old comments and the error when a read fails", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    api.worktreePrComments = () => Promise.reject({ code: "gh_failed", detail: "boom" });
    await store.load(PATH, 7);
    expect(store.get(PATH)?.comments).toHaveLength(1);
    expect(store.get(PATH)?.error?.code).toBe("gh_failed");
  });

  it("drops a read that a write overtook", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const read = api.worktreePrComments.bind(api);
    api.worktreePrComments = async (p, n) => {
      const got = await read(p, n);
      await slow;
      return got;
    };
    const reading = store.load(PATH, 7);
    const resolving = store.resolve(PATH, "T1", true);
    release();
    await Promise.all([reading, resolving]);
    expect(store.get(PATH)?.comments[0].resolved).toBe(true);
  });

  it("resolves at once and keeps it when GitHub agrees", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    const done = store.resolve(PATH, "T1", true);
    expect(store.get(PATH)?.comments[0].resolved).toBe(true);
    expect(await done).toBe(true);
    expect(store.get(PATH)?.error).toBeUndefined();
  });

  it("rolls a resolve back when it fails", async () => {
    const api = apiWith([comment(), comment({ id: 2, nodeId: "N2", replyTo: 1 })], { worktreePrThreadResolve: () => Promise.reject({ code: "gh_failed" }) });
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    expect(await store.resolve(PATH, "T1", true)).toBe(false);
    expect(store.get(PATH)?.comments.map((c) => c.resolved)).toEqual([false, false]);
    expect(store.get(PATH)?.error?.code).toBe("gh_failed");
  });

  it("reacts at once, then rolls back on failure", async () => {
    const api = apiWith([comment({ reactions: [{ content: "HEART", count: 1, mine: false }] })], { worktreePrReaction: () => Promise.reject({ code: "gh_failed" }) });
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    const pending = store.react(PATH, "N1", "HEART", true);
    expect(store.get(PATH)?.comments[0].reactions).toEqual([{ content: "HEART", count: 2, mine: true }]);
    expect(await pending).toBe(false);
    expect(store.get(PATH)?.comments[0].reactions).toEqual([{ content: "HEART", count: 1, mine: false }]);
  });

  it("adds a new reaction and removes the last one", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    await store.react(PATH, "N1", "ROCKET", true);
    expect(store.get(PATH)?.comments[0].reactions).toEqual([{ content: "ROCKET", count: 1, mine: true }]);
    await store.react(PATH, "N1", "ROCKET", false);
    expect(store.get(PATH)?.comments[0].reactions).toEqual([]);
  });

  it("reads again after a post, and rejects when the post fails", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    await store.post(PATH, 7, { body: "Fixed", replyTo: 1, path: null, line: null, startLine: null, commit: null });
    expect(store.get(PATH)?.comments).toHaveLength(2);
    await expect(store.post(PATH, 7, { body: " ", replyTo: null, path: null, line: null, startLine: null, commit: null })).rejects.toMatchObject({ code: "empty_comment" });
  });

  it("does not reuse a read that started before the post", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    await store.load(PATH, 7);
    let release: () => void = () => {};
    const slow = new Promise<void>((r) => (release = r));
    const read = api.worktreePrComments.bind(api);
    let first = true;
    api.worktreePrComments = async (p, n) => {
      const got = await read(p, n); // the list as it was before the post
      if (first) {
        first = false;
        await slow;
      }
      return got;
    };
    const stale = store.load(PATH, 7);
    await store.post(PATH, 7, { body: "Fixed", replyTo: 1, path: null, line: null, startLine: null, commit: null });
    release();
    await stale;
    expect(store.get(PATH)?.comments).toHaveLength(2);
  });

  it("tells subscribers about each change", async () => {
    const api = apiWith([comment()]);
    const store = new PrCommentStore(api);
    const seen = vi.fn();
    store.subscribe(seen);
    await store.load(PATH, 7);
    expect(seen).toHaveBeenCalled();
    expect(store.snapshot()).toBeGreaterThan(0);
  });
});
