import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

// The Pro gates in the browser mock (`src/mockLicense.ts`): early builds, saved layouts, usage history, About.

type Mock = { __licenseSet(state: unknown): void };

const PRO = {
  state: "active",
  plan: ["pro"],
  features: ["pro.phone", "pro.usage_history", "pro.session_replay", "pro.layouts", "pro.early"],
  freshness: { kind: "fresh" },
  pro: { grant: "g", perpetual: true, updatesUntil: 1825545600 },
  syncUntil: null,
  team: null,
  device: { fingerprint: "mockFingerprint0123456", max: 2, active: 1 },
};

const goPro = (page: Page) => page.evaluate((s) => (window as unknown as { xdevMock: Mock }).xdevMock.__licenseSet(s), PRO);

const openSection = async (page: Page, name: string) => {
  await page.getByRole("button", { name: "Settings" }).click();
  // In a narrow window the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((page.viewportSize()?.width ?? 1280) < 600 && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name, exact: true }).click();
};

const layoutMenu = (page: Page) => page.getByRole("button", { name: "Layout", exact: true });

async function openTwoTabs(page: Page) {
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  const allow = page.getByRole("button", { name: "Allow and start" });
  await allow.click();
  await expect(allow).toBeHidden();
  await page.getByRole("button", { name: "New tab" }).click();
  const item = page.getByRole("group", { name: "Agents" }).getByRole("menuitem", { name: "Claude Code" });
  await item.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("tab", { name: /^Claude Code/ })).toHaveCount(2);
}

test("free: picking the release candidate channel opens the upsell, and it closes", async ({ page, openApp }) => {
  await openApp();
  await openSection(page, "General");
  const channel = page.locator('[data-field="update-channel"]');
  await expect(channel.locator('option[value="rc"]')).toHaveText(/Pro/);
  await channel.selectOption("rc");
  const dialog = page.getByRole("dialog", { name: "Early builds is part of xDev Pro" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Get xDev Pro" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(channel).toHaveValue("stable");
});

test("saved layouts: tagged on free; on Pro a saved layout is listed and applies", async ({ page, openApp }) => {
  await openApp();
  await openTwoTabs(page);
  await layoutMenu(page).click();
  await expect(page.getByRole("menuitem", { name: /Save current layout · Pro/ })).toBeVisible();
  await page.keyboard.press("Escape");

  await goPro(page);
  await layoutMenu(page).click();
  await page.getByRole("menuitem", { name: "Save current layout" }).click();
  const dialog = page.getByRole("dialog", { name: "Save current layout" });
  await dialog.getByLabel("Layout name").fill("Review");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();

  await layoutMenu(page).click();
  await page.getByRole("menuitem", { name: "Review", exact: true }).click();
  await expect(page.getByText("Layout: Review.")).toBeVisible();
});

test("usage history: tagged on free, loads on Pro", async ({ page, openApp }) => {
  await openApp();
  await openSection(page, "Stats & Usage");
  const locked = page.locator('[data-field="usage-history-locked"]');
  await expect(locked.getByRole("button", { name: /Usage history/ })).toContainText("Pro");
  await goPro(page);
  await expect(locked).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Export CSV" })).toBeVisible();
});

test("About shows the plan", async ({ page, openApp }) => {
  await openApp("?license=pro");
  await page.getByRole("button", { name: "Help" }).click();
  await page.getByRole("menuitem", { name: /About/ }).click();
  await expect(page.getByText("Plan: Pro")).toBeVisible();
});

test("at 360px the upsell and the usage page fit", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await openSection(page, "Stats & Usage");
  expect(await fitsWidth(page)).toBe(true);
  await page.locator('[data-field="usage-history-locked"]').getByRole("button").click();
  await expect(page.getByRole("dialog", { name: "Usage history is part of xDev Pro" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
