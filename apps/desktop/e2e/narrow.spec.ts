import { expect, fitsWidth, test } from "./fixtures";

test("the main layout has no horizontal page scroll", async ({ page, openApp }) => {
  await openApp();
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});

test("settings has no horizontal page scroll", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
  await expect(page.getByRole("region", { name: "General", exact: true })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});

test("the app icon picker wraps without a horizontal page scroll", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  // At 360px the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
  const icons = page.getByRole("region", { name: "Appearance", exact: true }).getByRole("radiogroup", { name: "App icon" });
  await icons.scrollIntoViewIfNeeded();
  await expect(icons.getByText("Mono", { exact: true })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
