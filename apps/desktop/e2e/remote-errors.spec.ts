import { expect, fitsWidth, test } from "./fixtures";

// The error codes a remote project answers, through the browser mock: no network, no ssh.
test.use({ viewport: { width: 360, height: 740 } });

type Mock = {
  remoteProjectAdd(hostId: string, path: string): Promise<{ worktree: string }>;
  fileRead(worktree: string, rel: string): Promise<{ hash: string }>;
  fileWrite(worktree: string, rel: string, text: string, eol: string, expected: string | null): Promise<unknown>;
  worktreeCommit(path: string, files: string[], message: string): Promise<unknown>;
  worktreeFileDiff(path: string, file: string): Promise<unknown>;
  __remoteOffline(hostId: string): void;
  __remoteFail(hostId: string, code: string | null): void;
};

test("remote errors: offline writes and local-only worktree calls are refused with their codes", async ({ page, openApp, problems }) => {
  await openApp();
  const got = await page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const code = (p: Promise<unknown>) => p.then(() => "ok", (e: { code: string; detail?: string }) => `${e.code}:${e.detail ?? ""}`);
    const { worktree } = await mock.remoteProjectAdd("devbox", "/home/dev/app");
    const { hash } = await mock.fileRead(worktree, "README.md");
    const commit = await code(mock.worktreeCommit(worktree, ["README.md"], "x"));
    const diff = await code(mock.worktreeFileDiff(worktree, "README.md"));
    mock.__remoteFail("devbox", "remote_denied");
    const denied = await code(mock.fileRead(worktree, "README.md"));
    mock.__remoteFail("devbox", null);
    mock.__remoteOffline("devbox");
    const offline = await code(mock.fileWrite(worktree, "README.md", "x\n", "lf", hash));
    return { commit, diff, denied, offline };
  });

  expect(got).toEqual({
    commit: "remote_unsupported:worktree_commit",
    diff: "remote_unsupported:worktree_file_diff",
    denied: "remote_denied:devbox",
    offline: "remote_offline:devbox",
  });
  expect(await fitsWidth(page)).toBe(true);
  expect(problems).toEqual([]);
});
