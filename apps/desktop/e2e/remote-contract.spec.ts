import { expect, fitsWidth, test } from "./fixtures";

// The remote-project contract the app lane builds on, through the browser mock: no network, no ssh.
test.use({ viewport: { width: 360, height: 740 } });

type Mock = {
  remoteBrowse(hostId: string, path?: string): Promise<unknown>;
  remoteProjectAdd(hostId: string, path: string, name?: string): Promise<{ worktree: string; addedMs: number }>;
  remoteProjectsList(): Promise<unknown[]>;
  fileRead(worktree: string, rel: string): Promise<unknown>;
};

test("remote projects: browse, add, list and read over the mock host", async ({ page, openApp, problems }) => {
  await openApp();
  const got = await page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const browse = await mock.remoteBrowse("devbox");
    const added = await mock.remoteProjectAdd("devbox", "/home/dev/app");
    const list = await mock.remoteProjectsList();
    const file = await mock.fileRead(added.worktree, "README.md");
    return { browse, added, list, file };
  });

  expect(got.browse).toEqual({ path: "/home/dev", parent: "/home", dirs: [{ name: "app", path: "/home/dev/app" }], truncated: false });
  expect(got.added).toMatchObject({
    hostId: "devbox",
    hostAlias: "devbox",
    path: "/home/dev/app",
    name: "app",
    keepAlive: true,
    worktree: "ssh://devbox/home/dev/app",
    state: { state: "connected", tmux: true, git: true },
  });
  expect(typeof got.added.addedMs).toBe("number");
  expect(got.list).toEqual([got.added]);
  expect(got.file).toMatchObject({ rel: "README.md", kind: "text", eol: "lf", text: "# app\n\nA project on devbox.\n" });
  expect((got.file as { hash: string }).hash).toMatch(/^[0-9a-f]+$/);

  expect(await fitsWidth(page)).toBe(true);
  expect(problems).toEqual([]);
});
