import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

/** The first-run tip card sits over the bottom-right corner, where the launcher is. */
async function dismissTip(page: Page) {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

test("the composer sends a prompt to the tab in front and then to two tabs", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.locator(".xterm")).toBeVisible();

  await page.getByTestId("composer-launch").click();
  const composer = page.getByRole("dialog", { name: /^Prompt for / });
  await expect(composer).toBeVisible();
  const prompt = composer.getByRole("combobox", { name: "Prompt" });
  await expect(prompt).toBeFocused();
  await prompt.fill("echo first");
  await prompt.press("Shift+Enter");
  await prompt.pressSequentially("echo second");
  await expect(prompt).toHaveValue("echo first\necho second");
  await prompt.press("Enter");
  await expect(composer.getByRole("status").filter({ hasText: "Sent" })).toBeVisible({ timeout: 10_000 });
  await expect(prompt).toHaveValue("");

  // A second tab, then both ticked.
  await composer.getByRole("button", { name: "Close the composer" }).click();
  await expect(composer).toBeHidden();
  await page.getByRole("button", { name: "New tab" }).click();
  await page.getByRole("group", { name: "Shells" }).getByRole("menuitem", { name: "CMD" }).press("Enter");
  await expect(page.getByRole("tab", { name: "CMD" })).toBeVisible();

  await page.getByTestId("composer-launch").click();
  await expect(composer).toBeVisible();
  await composer.getByRole("checkbox", { name: "Send to several tabs" }).check();
  const targets = composer.getByTestId("composer-target");
  await expect(targets).toHaveCount(2);
  for (const row of await targets.all()) await row.getByRole("checkbox").check();
  await prompt.fill("git status");
  await composer.getByRole("button", { name: "Send to 2 tabs" }).click();
  await expect(composer.getByRole("status").filter({ hasText: "Sent to 2 of 2 tabs" })).toBeVisible({ timeout: 10_000 });
  await expect(targets.filter({ hasText: "Sent" })).toHaveCount(2);

  await page.keyboard.press("Escape");
  await expect(composer).toBeHidden();
  await expect(page.getByTestId("composer-launch")).toBeFocused();
});

test("at 360px the composer stays inside the window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  await page.getByTestId("composer-launch").click();
  const composer = page.getByRole("dialog", { name: /^Prompt for / });
  await expect(composer).toBeVisible();
  await composer.getByRole("checkbox", { name: "Send to several tabs" }).check();
  const box = (await composer.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
  expect(await fitsWidth(page)).toBe(true);
});
