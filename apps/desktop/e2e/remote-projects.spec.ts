import { expect, fitsWidth, test } from "./fixtures";
import type { Page } from "@playwright/test";

// Remote SSH projects through the browser mock: no network, no ssh.
type Mock = {
  fileRead(worktree: string, rel: string): Promise<{ text: string }>;
  __remoteDrop(hostId: string): void;
  __remoteOffline(hostId: string): void;
  __spawnRemoteHosts(): Record<string, string>;
};

async function dismissTip(page: Page): Promise<void> {
  const later = page.getByRole("button", { name: "Maybe later" });
  if (await later.isVisible()) await later.click();
}

async function addDevbox(page: Page): Promise<void> {
  await dismissTip(page);
  await page.getByRole("button", { name: "Add repo" }).click();
  await page.getByRole("button", { name: /Remote folder over SSH/ }).click();
  await expect(page.getByTestId("remote-path")).toHaveText("/home/dev");
  await page.getByRole("button", { name: "app", exact: true }).click();
  await expect(page.getByTestId("remote-path")).toHaveText("/home/dev/app");
  await page.getByRole("button", { name: "Open folder" }).click();
  await expect(page.getByText("devbox", { exact: true }).first()).toBeVisible();
}

test("add devbox, open README.md, edit and save", async ({ page, openApp }) => {
  await openApp();
  await addDevbox(page);
  // The name filter lists through `files_list`.
  await page.getByRole("button", { name: "Filter by name" }).click();
  await page.getByRole("searchbox").first().fill("README");
  await page.getByRole("treeitem", { name: "README.md" }).dblclick();
  const editor = page.getByRole("textbox", { name: "Document editor" });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("Control+End");
  await page.keyboard.type("edited over ssh");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => page.evaluate(async () => (await (window as unknown as { xdevMock: Mock }).xdevMock.fileRead("ssh://devbox/home/dev/app", "README.md")).text), { timeout: 5000 })
    .toContain("edited over ssh");
});

test("the folder tree of a remote project opens a file", async ({ page, openApp }) => {
  await openApp();
  await addDevbox(page);
  // The tree is built from `files_list`; `worktree_list_dir` refuses an ssh:// worktree.
  await page.getByRole("treeitem", { name: "src" }).click();
  await page.getByRole("treeitem", { name: "main.ts" }).click();
  const editor = page.getByRole("textbox", { name: "Document editor" });
  await expect(editor).toBeVisible();
  await expect(editor).toContainText("hello from devbox");
});

test("a dropped connection shows the reconnecting banner, then it goes away", async ({ page, openApp }) => {
  await openApp();
  await addDevbox(page);
  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__remoteDrop("devbox"));
  await expect(page.getByText("Reconnecting to devbox (attempt 1)…").first()).toBeVisible();
  await expect(page.getByText("Reconnecting to devbox (attempt 1)…")).toHaveCount(0, { timeout: 5000 });
});

test("an offline host shows the offline banner with Reconnect", async ({ page, openApp }) => {
  await openApp();
  await addDevbox(page);
  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__remoteOffline("devbox"));
  await expect(page.getByText("devbox is offline").first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reconnect", exact: true }).first()).toBeVisible();
});

test("a local project sets a remote target and starts an agent on the host", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  // The "New tab" menu exists once the worktree has a tab.
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.getByRole("tab", { name: "PowerShell" })).toBeVisible();
  await page.getByRole("button", { name: "New tab" }).click();
  // The terminal canvas can sit over the lower menu rows, so the items are used from the keyboard.
  await page.getByRole("menuitem", { name: "Set remote target…" }).focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").selectOption({ label: "devbox" });
  await dialog.getByRole("button", { name: "app", exact: true }).click();
  await dialog.getByRole("button", { name: "Save target" }).click();
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("menuitem", { name: /New agent on devbox/ }).focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => Object.values((window as unknown as { xdevMock: Mock }).xdevMock.__spawnRemoteHosts())), { timeout: 5000 }).toContain("devbox");
});

test.describe("narrow", () => {
  test.use({ viewport: { width: 360, height: 740 } });
  test("the add flow fits 360px", async ({ page, openApp, problems }) => {
    await openApp();
    await dismissTip(page);
    await page.getByRole("button", { name: "Add repo" }).click();
    await page.getByRole("button", { name: /Remote folder over SSH/ }).click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/dev");
    expect(await fitsWidth(page)).toBe(true);
    await page.getByRole("button", { name: "app", exact: true }).click();
    await expect(page.getByTestId("remote-path")).toHaveText("/home/dev/app");
    expect(await fitsWidth(page)).toBe(true);
    expect(problems).toEqual([]);
  });
});
