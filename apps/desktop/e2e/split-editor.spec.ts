import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

const isMac = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
const mod = async (page: Page) => ((await isMac(page)) ? "Meta" : "Control");

async function openReadme(page: Page) {
  await page.getByRole("treeitem", { name: "README.md" }).dblclick();
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCount(1);
}

async function quickOpen(page: Page, name: string, withMod?: boolean) {
  const m = await mod(page);
  await page.keyboard.press(`${m}+p`);
  const dialog = page.getByRole("dialog", { name: "Go to file" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(name);
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await page.keyboard.press(withMod ? `${m}+Enter` : "Enter");
  await expect(dialog).toBeHidden();
}

test("Mod+\\ shows the file in a second pane that follows the first", async ({ page, openApp }) => {
  await openApp();
  await openReadme(page);
  const m = await mod(page);
  await page.locator(".cm-content").first().click();
  await page.keyboard.press(`${m}+\\`);
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  const [left, right] = [page.locator(".cm-content").nth(0), page.locator(".cm-content").nth(1)];
  await expect(right).toHaveText((await left.textContent()) ?? "");

  // Typing in the right view shows in the left one; each tab has one dirty dot.
  await right.click();
  await page.keyboard.press(`${m}+End`);
  await page.keyboard.type("SPLITMARK");
  await expect(left).toContainText("SPLITMARK");
  await expect(page.locator(".ws-tab-dirty")).toHaveCount(2);
  await expect(page.getByRole("tab", { name: "README.md" }).first().locator("xpath=..").locator(".ws-tab-dirty")).toHaveCount(1);

  // Mod+S saves: the dots go.
  await page.keyboard.press(`${m}+s`);
  await expect(page.locator(".ws-tab-dirty")).toHaveCount(0);

  // Closing the file tab closes the view with it.
  const tabs = page.getByRole("tab", { name: "README.md" });
  await expect(tabs).toHaveCount(2);
  await tabs.first().click({ button: "middle" });
  await expect(page.locator(".cm-editor")).toHaveCount(0);
  await expect(page.getByRole("tab", { name: "README.md" })).toHaveCount(0);
});

test("the tab menu splits another file down into a top and bottom layout", async ({ page, openApp }) => {
  await openApp();
  await openReadme(page);
  await quickOpen(page, "session.ts");
  await expect(page.getByRole("tab", { name: "session.ts" })).toBeVisible();
  await page.getByRole("tab", { name: "session.ts" }).click({ button: "right" });
  await page.getByRole("menuitem", { name: "Split down" }).click();
  await expect(page.getByRole("tab", { name: "session.ts" })).toHaveCount(2);
  const boxes = await page.locator(".cm-editor").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0));
  expect(boxes.length).toBeGreaterThanOrEqual(2);
  const [a, b] = boxes.sort((x, y) => x.top - y.top);
  expect(b.top).toBeGreaterThanOrEqual(a.bottom - 1);
  expect(Math.abs(a.left - b.left)).toBeLessThan(4);
});

test("Quick open with Mod+Enter opens the file to the side", async ({ page, openApp }) => {
  await openApp();
  await openReadme(page);
  await quickOpen(page, "session.ts", true);
  await expect(page.getByRole("tab", { name: "session.ts" })).toBeVisible();
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  const boxes = await page.locator(".cm-editor").evaluateAll((els) => els.map((e) => e.getBoundingClientRect()));
  const [a, b] = boxes.sort((x, y) => x.left - y.left);
  expect(b.left).toBeGreaterThanOrEqual(a.right - 1);
});

test("a split editor fits at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  // The tree is folded away at this width; Quick open reaches the file.
  await quickOpen(page, "README.md");
  await expect(page.locator(".cm-editor")).toHaveCount(1);
  // A tip card covers part of the narrow window, so the editor gets focus without a click.
  await page.locator(".cm-content").first().focus();
  await page.keyboard.press(`${await mod(page)}+\\`);
  await expect(page.locator(".cm-editor")).toHaveCount(2);
  expect(await fitsWidth(page)).toBe(true);
});
