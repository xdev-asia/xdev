import { expect, test } from "./fixtures";

test("the appearance page picks an app icon", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  const region = page.getByRole("region", { name: "Appearance", exact: true });
  const icons = region.getByRole("radiogroup", { name: "App icon" });
  await expect(icons.getByRole("radio")).toHaveCount(6);
  await expect(icons.getByRole("radio", { name: "Default" })).toBeChecked();
  await icons.getByText("Midnight", { exact: true }).click();
  await expect(icons.getByRole("radio", { name: "Midnight" })).toBeChecked();
  await expect(icons.getByRole("radio", { name: "Default" })).not.toBeChecked();
});
