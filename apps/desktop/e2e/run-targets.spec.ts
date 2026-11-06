import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = { __targetsUntrusted(v: boolean): void; __targetsTyped(): Record<string, string> };
const typed = (page: Page) =>
  page.evaluate(() => Object.values((window as unknown as { xdevMock: Mock }).xdevMock.__targetsTyped()).join("|"));

// Like the other specs, the keyboard picks a menu item: over a terminal the pane's canvas layer takes mouse clicks.
async function choose(item: Locator) {
  await item.focus();
  await item.press("Enter");
}

async function openMenu(page: Page) {
  // The strip with its `+` appears once a worktree has a tab.
  const start = page.getByRole("button", { name: "PowerShell", exact: true });
  if (await start.isVisible()) {
    await start.click();
    await expect(page.getByRole("tab", { name: "PowerShell" })).toBeVisible();
  }
  await page.getByRole("button", { name: "New tab" }).click();
  const group = page.getByRole("group", { name: "Run targets" });
  await expect(group).toBeVisible();
  return group;
}

test("the Run targets block lists the deploy presets", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  const deploy = group.getByRole("group", { name: "Deploy" });
  for (const name of ["Vercel preview", "Vercel production", "Staging"]) {
    await expect(deploy.getByRole("menuitem", { name: new RegExp(`^${name}`) })).toBeVisible();
  }
});

test("a preset opens a titled tab and types its command", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await choose(group.getByRole("menuitem", { name: /^Vercel preview/ }));
  await expect(page.getByRole("tab", { name: /Deploy: Vercel preview/ })).toBeVisible();
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("vercel deploy");
});

test("a production preset asks first; Cancel types nothing, Run deploy types the command", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await choose(group.getByRole("menuitem", { name: /^Vercel production/ }));
  const dialog = page.getByRole("dialog", { name: /Deploy Vercel production/ });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("vercel deploy --prod");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: /Deploy: Vercel production/ })).toHaveCount(0);
  expect(await typed(page)).not.toContain("vercel deploy --prod");

  const again = await openMenu(page);
  await choose(again.getByRole("menuitem", { name: /^Vercel production/ }));
  await dialog.getByRole("button", { name: "Run deploy" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: /Deploy: Vercel production/ })).toBeVisible();
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("vercel deploy --prod");
});

test("an untrusted xdev.toml disables its presets and offers review", async ({ page, openApp }) => {
  await openApp();
  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__targetsUntrusted(true));
  const group = await openMenu(page);
  await expect(group.getByRole("menuitem", { name: /^Staging/ })).toBeDisabled();
  await expect(group.getByRole("menuitem", { name: /^Vercel preview/ })).toBeEnabled();
  await expect(group.getByRole("menuitem", { name: "Review and trust" })).toBeVisible();
});

test("Open server shell opens an ssh tab and the notes file", async ({ page, openApp }) => {
  await openApp();
  const group = await openMenu(page);
  await choose(group.getByRole("menuitem", { name: /^Open server shell/ }));
  await expect(page.getByRole("tab", { name: /prod-1/ })).toBeVisible();
  await expect(page.getByRole("tab", { name: /deploy\.md/ })).toBeVisible();
  await expect.poll(() => typed(page), { timeout: 5000 }).toContain("cd /srv/app");
});

test("a project with no targets says so", async ({ page, openApp }) => {
  await openApp("?targets=empty");
  const group = await openMenu(page);
  await expect(group).toContainText("No deploy targets found");
});

test("the menu and the confirm fit a 360px window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 700 });
  await openApp();
  // At 360px the workspace sidebar covers the pane until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  const group = await openMenu(page);
  expect(await fitsWidth(page)).toBe(true);
  await choose(group.getByRole("menuitem", { name: /^Vercel production/ }));
  await expect(page.getByRole("dialog", { name: /Deploy Vercel production/ })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
