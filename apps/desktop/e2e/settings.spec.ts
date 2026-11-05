import { expect, test } from "./fixtures";

const openSettings = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  return nav;
};

test("every settings section opens its page", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  const names = (await nav.getByRole("group").getByRole("button").allTextContents()).map((n) => n.trim());
  expect(names.length).toBeGreaterThanOrEqual(20);
  for (const name of names) {
    await nav.getByRole("button", { name, exact: true }).click();
    await expect(page.getByRole("region", { name, exact: true }), `section ${name}`).toBeVisible();
  }
});

test("settings search filters the nav and clearing restores it", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  const all = await nav.getByRole("group").getByRole("button").count();
  await nav.getByRole("searchbox", { name: "Search settings" }).fill("font");
  await expect(nav.getByRole("button", { name: /^Terminal \d+$/ })).toBeVisible();
  await expect(nav.getByRole("button", { name: /^General/ })).toBeHidden();
  expect(await nav.getByRole("group").getByRole("button").count()).toBeLessThan(all);
  await nav.getByRole("button", { name: "Clear search" }).click();
  await expect(nav.getByRole("group").getByRole("button")).toHaveCount(all);
});

test("the SSH page renders", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  await nav.getByRole("button", { name: "SSH", exact: true }).click();
  await expect(page.getByRole("region", { name: "SSH", exact: true })).toBeVisible();
});

test("the command line page renders", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  await nav.getByRole("button", { name: "Command line" }).click();
  await expect(page.getByRole("region", { name: "Command line" })).toBeVisible();
});

test("the advanced page renders", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  await nav.getByRole("button", { name: "Advanced", exact: true }).click();
  const region = page.getByRole("region", { name: "Advanced", exact: true });
  await expect(region).toBeVisible();
  await expect(region.getByRole("textbox", { name: /^Proxy URL/ })).toBeVisible();
  await expect(region.getByRole("button", { name: "Save changes" })).toBeDisabled();
});

test("the appearance page switches the custom title bar", async ({ page, openApp }) => {
  await openApp();
  const nav = await openSettings(page);
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  const region = page.getByRole("region", { name: "Appearance", exact: true });
  await expect(region).toBeVisible();
  const titleBar = region.getByRole("group", { name: "Title bar" });
  const appName = region.getByRole("switch", { name: "Show app name in title bar" });
  await expect(titleBar.getByRole("button", { name: "Native" })).toHaveAttribute("aria-pressed", "true");
  await expect(appName).toBeDisabled();
  await titleBar.getByRole("button", { name: "Custom" }).click();
  await expect(titleBar.getByRole("button", { name: "Custom" })).toHaveAttribute("aria-pressed", "true");
  await expect(appName).toBeEnabled();
  await titleBar.getByRole("button", { name: "Native" }).click();
  await expect(appName).toBeDisabled();
});

test("the last settings section stays reachable in a short window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await openApp();
  const nav = await openSettings(page);
  await nav.getByRole("button", { name: "Experimental", exact: true }).click();
  await expect(page.getByRole("region", { name: "Experimental", exact: true })).toBeVisible();
});
