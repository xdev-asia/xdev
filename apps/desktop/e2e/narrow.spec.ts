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

test("Mission Control fits at 360px", async ({ page, openApp }) => {
  await openApp();
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Open Mission Control");
  await palette.getByRole("option", { name: "Open Mission Control" }).click();
  const mission = page.getByRole("dialog", { name: "Mission Control" });
  await expect(mission.getByRole("listitem", { name: "Builder" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  const box = await mission.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  await mission.getByRole("tab", { name: "Team map" }).click();
  await expect(mission.getByRole("button", { name: "Lead, focus tab" })).toBeVisible();
});

test("at 360px the pane chips fold behind one button and the page does not scroll", async ({ page, openApp }) => {
  await openApp();
  // At 360px the first-run tip covers the empty state; "Maybe later" puts it away.
  await page.getByRole("button", { name: "Maybe later" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Allow and start" }).click();
  const id = (await page.locator('.ws-tab[data-selected="true"]').getAttribute("data-tab-id"))!;
  await page.evaluate((tab) => (window as unknown as { xdevMock: { __hook(id: string, e: string): void } }).xdevMock.__hook(tab, "prompt"), id);
  await expect(page.getByRole("button", { name: "Pane details" })).toBeVisible();
  await expect(page.locator('.pane-chips [data-chip="timer"]')).toHaveCount(0);
  await page.getByRole("button", { name: "Pane details" }).click();
  await expect(page.getByRole("dialog", { name: "Pane details" }).locator('[data-chip="timer"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Sticky note", exact: true })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});

test("workspace parts and the PATH editor fit at 360px", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "Appearance", exact: true }).click();
  const parts = page.getByRole("region", { name: "Appearance", exact: true }).getByRole("list", { name: "Workspace parts" });
  await parts.scrollIntoViewIfNeeded();
  await expect(parts.getByRole("button", { name: "Move Agent kit up" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await nav.getByRole("button", { name: "Agents", exact: true }).click();
  const path = page.getByRole("region", { name: "Agents", exact: true }).getByRole("list", { name: "PATH" });
  await path.scrollIntoViewIfNeeded();
  await expect(path.getByText("/opt/missing/bin")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
