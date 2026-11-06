import { expect, fitsWidth, test } from "./fixtures";

test("the theme editor makes, applies, imports, exports and deletes a theme", async ({ page, openApp }) => {
  // The app follows the system, so the painted mode (where the editor starts) is the dark one.
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  const region = page.getByRole("region", { name: "Appearance", exact: true });
  const select = region.getByLabel("Colour theme", { exact: true });
  const text1 = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-1").trim());

  await expect(select).toHaveValue("");
  await expect(region.getByRole("button", { name: "Edit", exact: true })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Export…" })).toBeDisabled();
  await expect(region.getByRole("button", { name: "Delete" })).toBeDisabled();
  const builtIn = await text1();

  await region.getByRole("button", { name: "New theme" }).click();
  const panel = region.getByRole("form", { name: "New theme" });
  await panel.getByLabel("Theme name").fill("Night");

  // A dark primary text on the dark ground fails AA, and the page shows it at once.
  await panel.getByLabel("Primary text", { exact: true }).fill("#111111");
  await expect(panel.getByText(/Primary text on Ground is/)).toBeVisible();
  await expect.poll(text1).toBe("#111111");

  await panel.getByRole("button", { name: "Save theme" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Saved Night." })).toBeVisible();
  await expect(select).toHaveValue("night");
  await expect(panel).toHaveCount(0);
  await expect.poll(text1).toBe("#111111");
  expect(await page.evaluate(() => localStorage.getItem("xdev.appThemeCss"))).toContain("#111111");

  await region.getByRole("button", { name: "Export…" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Exported to /home/demo/night.xdev-theme.json." })).toBeVisible();

  await region.getByRole("button", { name: "Import…" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Imported Dusk." })).toBeVisible();
  await expect(select.getByRole("option", { name: "Dusk" })).toHaveCount(1);

  await region.getByRole("button", { name: "Delete" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Deleted Night." })).toBeVisible();
  await expect(select).toHaveValue("");
  await expect.poll(text1).toBe(builtIn);
  expect(await page.evaluate(() => localStorage.getItem("xdev.appThemeCss"))).toBeNull();
});

test("Cancel puts the painted colours back", async ({ page, openApp }) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
  const region = page.getByRole("region", { name: "Appearance", exact: true });
  const text1 = () => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--text-1").trim());
  const builtIn = await text1();
  await region.getByRole("button", { name: "New theme" }).click();
  await region.getByLabel("Primary text", { exact: true }).fill("#111111");
  await expect.poll(text1).toBe("#111111");
  await region.getByRole("button", { name: "Cancel" }).click();
  await expect.poll(text1).toBe(builtIn);
});

test("the theme editor fits 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  // At 360px the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Appearance", exact: true }).click();
  const region = page.getByRole("region", { name: "Appearance", exact: true });
  await region.getByRole("button", { name: "New theme" }).click();
  await expect(region.getByRole("form", { name: "New theme" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
