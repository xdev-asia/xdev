import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

// Settings → xDev ID → License, in the browser mock (`src/mockLicense.ts`). No network.

type Mock = { __licenseCheckoutComplete(): void; __licenseRefreshes(): number };

const offline = (page: Page) => page.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)[:/])/, (route) => route.abort());

const openAccount = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  // In a narrow window the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((page.viewportSize()?.width ?? 1280) < 600 && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "xDev ID", exact: true }).click();
  const region = page.getByRole("region", { name: "xDev ID", exact: true });
  await expect(region).toBeVisible();
  return region;
};

const card = (page: Page) => page.locator('[data-setting="license"]');

test("a free plan shows Get xDev Pro; buying waits, and finishing in the browser shows Pro", async ({ page, openApp }) => {
  await offline(page);
  await openApp();
  await openAccount(page);
  await expect(card(page).getByText("Plan: Free")).toBeVisible();
  await card(page).getByRole("button", { name: "Get xDev Pro" }).click();
  await expect(card(page).getByText("Waiting for your purchase in the browser.", { exact: true }).last()).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Stop waiting" })).toBeVisible();

  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__licenseCheckoutComplete());
  await expect(card(page).getByText("Plan: Pro")).toBeVisible();
  await expect(card(page).getByText("Devices: 1 of 1")).toBeVisible();
  await expect(card(page).getByText(/Pro updates until/)).toBeVisible();
  await expect(card(page).getByRole("button", { name: "Refresh license" })).toBeVisible();
  await expect(card(page).getByText("Waiting for your purchase in the browser.", { exact: true })).toHaveCount(0);
});

test("with no free seat, activating opens a dialog that moves the license here", async ({ page, openApp }) => {
  await offline(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp("?license=noseat");
  await openAccount(page);
  expect(await fitsWidth(page)).toBe(true);
  await card(page).getByRole("button", { name: "Activate on this computer" }).click();

  const dialog = page.getByRole("dialog", { name: "Move Pro to this computer" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("studio-mac")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await dialog.getByRole("button", { name: "Move license here from studio-mac" }).click();
  await expect(dialog).toBeHidden();
  await expect(card(page).getByText("Plan: Pro")).toBeVisible();
});

test("offline for days: the grace notice is shown", async ({ page, openApp }) => {
  await offline(page);
  await openApp("?license=grace");
  await openAccount(page);
  await expect(card(page).getByText("You have been offline for 9 days")).toBeVisible();
  await expect(card(page).getByText("Plan: Pro")).toBeVisible();
});

test("the palette has Refresh license", async ({ page, openApp }) => {
  await offline(page);
  await openApp("?license=pro");
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Refresh license");
  await palette.getByRole("option", { name: /Refresh license/ }).first().click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__licenseRefreshes()), { timeout: 5_000 }).toBe(1);
});

test("the Account page fits at 360px, free and Pro", async ({ page, openApp }) => {
  await offline(page);
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp("?license=pro");
  await openAccount(page);
  await expect(card(page).getByText("Plan: Pro")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
