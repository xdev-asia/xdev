import { expect, test } from "./fixtures";

test("loads into the demo workspace", async ({ page, openApp }) => {
  await openApp();
  await expect(page.getByRole("complementary", { name: "Workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^xdev primary main/ })).toBeVisible();
  await expect(page.getByRole("tree", { name: "Files of this worktree" })).toBeVisible();
  await expect(page.getByRole("contentinfo")).toContainText("v0.7.0");
});

test("first launch shows the setup wizard and ends in the workspace", async ({ page }) => {
  await page.goto("/?welcome");
  await expect(page.getByRole("heading", { name: "Choose your default agent", level: 1 })).toBeVisible();
  await expect(page.getByText("Step 1 of 4")).toBeVisible();
  await expect(page.getByRole("button", { name: "Back" })).toBeDisabled();
  await page.getByRole("button", { name: "Next" }).click();
  await expect(page.getByText("Step 2 of 4")).toBeVisible();
  await page.getByRole("button", { name: "Skip" }).click();
  await page.getByRole("dialog", { name: "Skip setup?" }).getByRole("button", { name: "Skip setup" }).click();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
});

test("a pending update shows in the status bar", async ({ page, openApp }) => {
  await openApp("?update=0.4.0");
  await expect(page.getByRole("contentinfo").getByRole("button", { name: "Update to 0.4.0" })).toBeVisible();
});

test("a pending crash report opens the crash dialog", async ({ page, openApp }) => {
  await openApp("?crash");
  const dialog = page.getByRole("dialog", { name: "xDev closed unexpectedly" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("index out of bounds")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toBeHidden();
});

test("the header search hint sits inside the search button", async ({ page, openApp }) => {
  await openApp();
  const search = await page.locator(".ws-search").boundingBox();
  const hint = await page.locator(".ws-search-hint").boundingBox();
  expect(search && hint).toBeTruthy();
  expect(hint!.x + hint!.width).toBeLessThanOrEqual(search!.x + search!.width + 1);
});
