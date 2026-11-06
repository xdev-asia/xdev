import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

async function startClaude(page: Page, first: boolean) {
  if (first) {
    await page.getByRole("button", { name: "Claude Code", exact: true }).click();
    const allow = page.getByRole("button", { name: "Allow and start" });
    await allow.click();
    await expect(allow).toBeHidden();
    return;
  }
  await page.getByRole("button", { name: "New tab" }).click();
  const item = page.getByRole("group", { name: "Agents" }).getByRole("menuitem", { name: "Claude Code" });
  await item.focus();
  await page.keyboard.press("Enter");
}

async function openFourTabs(page: Page) {
  for (let i = 0; i < 4; i++) await startClaude(page, i === 0);
  await expect(page.getByRole("tab", { name: /^Claude Code/ })).toHaveCount(4);
}

const layoutMenu = (page: Page) => page.getByRole("button", { name: "Layout", exact: true });

async function pick(page: Page, name: string) {
  await layoutMenu(page).click();
  await page.locator('[role^="menuitem"]').filter({ hasText: new RegExp(name) }).filter({ hasNotText: "all projects" }).click();
}

test("Grid arranges four agent tabs as a 2x2 grid of four panes", async ({ page, openApp }) => {
  await openApp();
  await openFourTabs(page);
  await pick(page, "Grid");
  const panes = page.locator(".ws-pane[data-pane]");
  await expect(panes).toHaveCount(4);
  const boxes = await panes.evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).map((r) => ({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) })));
  expect(new Set(boxes.map((b) => b.x)).size).toBe(2);
  expect(new Set(boxes.map((b) => b.y)).size).toBe(2);
  expect(Math.abs(boxes[0].w - boxes[1].w)).toBeLessThanOrEqual(2);
  expect(Math.abs(boxes[0].h - boxes[2].h)).toBeLessThanOrEqual(2);
  // No tab was closed.
  await expect(page.getByRole("tab", { name: /^Claude Code/ })).toHaveCount(4);
});

test("Apply to all projects asks first, and Cancel changes nothing", async ({ page, openApp }) => {
  await openApp();
  await openFourTabs(page);
  await layoutMenu(page).click();
  await page.locator('[role^="menuitem"]').filter({ hasText: /^Grid in all projects$/ }).click();
  const dialog = page.getByRole("dialog", { name: /Apply Grid to all projects/ });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".ws-pane[data-pane]")).toHaveCount(1);

  await layoutMenu(page).click();
  await page.locator('[role^="menuitem"]').filter({ hasText: /^Grid in all projects$/ }).click();
  await dialog.getByRole("button", { name: "Apply to all" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator(".ws-pane[data-pane]")).toHaveCount(4);
  await expect(page.getByRole("status").filter({ hasText: /Layout: Grid in \d+ project/ })).toHaveCount(1);
});

test("palette: Layout commands are listed", async ({ page, openApp }) => {
  await openApp();
  await openFourTabs(page);
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Layout: Columns");
  await palette.getByRole("option", { name: /^Layout: Columns(?! in all)/ }).click();
  await expect(page.locator(".ws-pane[data-pane]")).toHaveCount(4);
});

test("canvas: a dragged card keeps its position after a reload", async ({ page, openApp }) => {
  await openApp("?layoutkeep");
  await openFourTabs(page);
  await pick(page, "Grid");
  await pick(page, "Canvas");
  const cards = page.locator(".cv-card");
  await expect(cards).toHaveCount(4);
  const grip = cards.first().locator(".cv-grip");
  const before = await cards.first().boundingBox();
  const g = (await grip.boundingBox())!;
  await page.mouse.move(g.x + g.width / 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x + g.width / 2 + 60, g.y + g.height / 2 + 40, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await cards.first().boundingBox())!.x, { timeout: 5000 }).toBeCloseTo(before!.x + 60, -1);
  const moved = (await cards.first().boundingBox())!;
  expect(Math.round(moved.y - before!.y)).toBeGreaterThanOrEqual(30);

  // The layout is written one second after the last change; a reload before that would lose it.
  await page.waitForTimeout(1500);
  await page.reload();
  await expect(cards).toHaveCount(4, { timeout: 10000 });
  const after = (await cards.first().boundingBox())!;
  expect(Math.abs(after.x - moved.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(after.y - moved.y)).toBeLessThanOrEqual(2);
});

test("canvas: keyboard pans and zooms, and leaving returns to the tree", async ({ page, openApp }) => {
  await openApp();
  await openFourTabs(page);
  await pick(page, "Grid");
  await pick(page, "Canvas");
  const surface = page.getByRole("group", { name: "Terminal canvas" });
  await surface.focus();
  const zoom = page.getByRole("toolbar", { name: "Canvas zoom" });
  await expect(zoom).toContainText("100");
  await page.keyboard.press("+");
  await expect(zoom).not.toContainText("100%");
  await page.keyboard.press("0");
  await expect(zoom).toContainText("100");
  await pick(page, "Canvas");
  await expect(page.locator(".cv-card")).toHaveCount(0);
  await expect(page.locator(".ws-pane[data-pane]")).toHaveCount(4);
});

test.describe("360px", () => {
  test.use({ viewport: { width: 360, height: 740 } });

  test("the layout menu and the canvas fit without page scroll", async ({ page, openApp }) => {
    await openApp();
    // At 360px the workspace sidebar covers the pane area until it is hidden.
    const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
    if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
    await openFourTabs(page);
    await pick(page, "Grid");
    expect(await fitsWidth(page)).toBe(true);
    await pick(page, "Canvas");
    await expect(page.locator(".cv-card")).toHaveCount(4);
    await expect(page.getByRole("button", { name: "Fit all panes" })).toBeVisible();
    expect(await fitsWidth(page)).toBe(true);
  });
});
