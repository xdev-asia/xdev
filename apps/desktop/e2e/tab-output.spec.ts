import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

async function dismissTip(page: Page) {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

/** Opens a shell tab in the worktree whose row has `data-path`. */
async function shellIn(page: Page, path: string) {
  await page.locator(`li[data-path="${path}"] .ws-wt-main`).click();
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.locator(".xterm:visible")).toHaveCount(1);
}

test("hovering a tab shows the last lines of its output", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  const tab = page.getByRole("tab", { name: "PowerShell" });
  await expect(tab).toBeVisible();
  await tab.hover();
  const lines = page.locator("[data-tab-output]");
  await expect(lines).toContainText("xDev demo terminal", { timeout: 10_000 });
  await page.mouse.move(0, 0);
  await expect(lines).toBeHidden();
});

test("two selected worktrees merge into one document with both headers", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await shellIn(page, "/demo/wt/xdev-oak");
  await shellIn(page, "/demo/wt/xdev-elm");
  await page.locator('li[data-path="/demo/wt/xdev-oak"] .ws-wt-main').click({ modifiers: ["ControlOrMeta"] });
  await page.locator('li[data-path="/demo/wt/xdev-elm"] .ws-wt-main').click({ modifiers: ["ControlOrMeta"] });
  const bar = page.getByRole("toolbar", { name: "Selected worktrees" }).or(page.getByRole("region", { name: "Selected worktrees" }));
  await bar.getByRole("button", { name: "Merge output" }).click();
  const dialog = page.getByRole("dialog", { name: "Merge output" });
  await expect(dialog).toBeVisible();
  const preview = dialog.locator(".merge-pre");
  await expect(preview).toContainText("=== PowerShell (PowerShell) ===", { timeout: 10_000 });
  const text = (await preview.textContent()) ?? "";
  expect(text.match(/^=== /gm)?.length).toBe(2);
  await expect(dialog.getByRole("button", { name: "Save as…" })).toBeVisible();
});

test("at 360px the resource manager lists the app and fits the window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("resource manager");
  await palette.getByRole("option", { name: "Open resource manager" }).click();
  const dialog = page.getByRole("dialog", { name: "Resource manager" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-resource-app]")).toBeVisible();
  await expect(dialog.locator("[data-resource-tab]").first()).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box!.x + box!.width).toBeLessThanOrEqual(360);
});
