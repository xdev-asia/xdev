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
