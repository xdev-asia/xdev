import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = { __targetsTyped(): Record<string, string> };
const typed = (page: Page) =>
  page.evaluate(() => Object.values((window as unknown as { xdevMock: Mock }).xdevMock.__targetsTyped()).join("|"));

// The keyboard picks a menu item: over a terminal the pane's canvas layer takes mouse clicks.
async function choose(item: Locator) {
  await item.focus();
  await item.press("Enter");
}

async function openMenu(page: Page) {
  const start = page.getByRole("button", { name: "PowerShell", exact: true });
  if (await start.isVisible()) {
    await start.click();
    await expect(page.getByRole("tab", { name: "PowerShell" })).toBeVisible();
  }
  await page.getByRole("button", { name: "New tab" }).click();
  const group = page.getByRole("group", { name: "Simulators" });
  await expect(group).toBeVisible();
  return group;
}

test("the Simulators group lists the iOS simulators and the AVD", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await expect(group.getByRole("menuitem", { name: /iPhone 16 · iOS 18\.0 · Running/ })).toBeVisible();
  await expect(group.getByRole("menuitem", { name: /iPhone 15 · iOS 17\.5 · Not running/ })).toBeVisible();
  await expect(group.getByRole("menuitem", { name: /Pixel_8_API_35/ })).toBeVisible();
});

test("a stopped iPhone opens a log tab and types the log stream", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await choose(group.getByRole("menuitem", { name: /^iPhone 15/ }));
  await expect(page.getByRole("tab", { name: /Logs: iPhone 15/ })).toBeVisible();
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("log stream");
});

test("an AVD opens an emulator tab and a log tab", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await choose(group.getByRole("menuitem", { name: /Pixel_8_API_35/ }));
  await expect(page.getByRole("tab", { name: /Logs: Pixel_8_API_35/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: "Pixel_8_API_35", exact: true })).toBeVisible();
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("emulator -avd Pixel_8_API_35");
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("adb logcat");
});

test("with no tools both problems show", async ({ page, openApp }) => {
  await openApp("?sims=none");
  const group = await openMenu(page);
  await expect(group).toContainText("Xcode command line tools were not found.");
  await expect(group).toContainText("The Android emulator was not found.");
  await expect(group).toContainText("No simulators found.");
});

test("the menu fits a 360px window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openApp();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  const group = await openMenu(page);
  await expect(group.getByRole("menuitem", { name: /iPhone 15/ })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
