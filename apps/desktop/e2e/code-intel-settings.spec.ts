import { expect, fitsWidth, test } from "./fixtures";

const NAME = "Code intelligence";

const openCodeIntel = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: NAME, exact: true }).click();
  const region = page.getByRole("region", { name: NAME, exact: true });
  await expect(region).toBeVisible();
  return { nav, region };
};

test("the rows say which servers are found", async ({ page, openApp }) => {
  await openApp();
  const { region } = await openCodeIntel(page);
  const ts = region.locator('[data-language="typescript"]');
  await expect(ts).toContainText("TypeScript and JavaScript");
  await expect(ts).toContainText("Found: /usr/local/bin/typescript-language-server");
  const python = region.locator('[data-language="python"]');
  await expect(python).toContainText("Not found");
  await expect(python).toContainText("Install pyright-langserver and make sure it is on your PATH, then select Look again.");
});

test("a language turned off stays off after leaving the page", async ({ page, openApp }) => {
  await openApp();
  const { nav, region } = await openCodeIntel(page);
  const rust = region.getByRole("switch", { name: "Use the Rust server" });
  await expect(rust).toBeChecked();
  await rust.uncheck();
  await expect(rust).not.toBeChecked();
  await nav.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("region", { name: "General", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: NAME, exact: true }).click();
  await expect(page.getByRole("region", { name: NAME, exact: true }).getByRole("switch", { name: "Use the Rust server" })).not.toBeChecked();
});

test("Look again keeps the list", async ({ page, openApp }) => {
  await openApp();
  const { region } = await openCodeIntel(page);
  await expect(region.locator("[data-language]")).toHaveCount(5);
  await region.getByRole("button", { name: "Look again" }).click();
  await expect(region.locator("[data-language]")).toHaveCount(5);
  await expect(region.locator('[data-language="rust"]')).toContainText("Found: /usr/local/bin/rust-analyzer");
});

test("searching for language server finds the page", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("searchbox", { name: "Search settings" }).fill("language server");
  const hit = nav.getByRole("button", { name: new RegExp(`^${NAME}`) });
  await expect(hit).toBeVisible();
  await expect(nav.getByRole("button", { name: /^General/ })).toBeHidden();
  await hit.click();
  await expect(page.getByRole("region", { name: NAME, exact: true }).getByRole("switch", { name: "Use language servers" })).toBeVisible();
});

test("the page fits a 360px screen", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: NAME, exact: true }).click();
  await expect(page.getByRole("region", { name: NAME, exact: true }).getByRole("switch", { name: "Use language servers" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
