import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = { __addChange(path: string, change: { path: string; kind: "added" | "modified" | "deleted" }): void };
const OAK = "/demo/wt/xdev-oak";

/** Opens the review tab of the demo worktree `oak` from its Changes list, on `file`. */
async function openReview(page: Page, file: string): Promise<void> {
  await page.getByRole("button", { name: /^oak/ }).first().click();
  // At 360px the sidebar covers the panels until it is hidden.
  if ((page.viewportSize()?.width ?? 1280) < 600) {
    const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
    if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  }
  await page.getByRole("tab", { name: /^Changes/ }).click();
  const row = page.getByRole("tabpanel").getByText(file, { exact: true }).first();
  await row.click();
  await expect(page.getByRole("tab", { name: "Review" })).toBeVisible();
  await expect(page.locator(`.rv-file[data-path="${file}"]`)).toBeVisible();
}

test("Review with AI shows AI notes that can be dismissed or turned into notes", async ({ page, openApp }) => {
  await openApp();
  await openReview(page, "src/session.ts");

  await page.getByRole("button", { name: "Review with AI" }).click();
  await expect(page.getByRole("status").filter({ hasText: "AI review done. Findings: 2." })).toBeVisible({ timeout: 15_000 });
  // One finding per file, marked AI, under its line.
  const cards = page.getByRole("article", { name: "AI finding" });
  await expect(cards).toHaveCount(2, { timeout: 15_000 });
  const session = page.locator('.rv-file[data-path="src/session.ts"]').getByRole("article", { name: "AI finding" });
  await expect(session).toContainText("Check that src/session.ts still handles the old value.");
  await expect(session.getByText("AI", { exact: true })).toBeVisible();

  // Turn one into a note: it leaves the AI list and joins the notes.
  await session.getByRole("button", { name: "Turn into note" }).click();
  await expect(page.getByRole("button", { name: "Notes (1)" })).toBeVisible();
  await expect(cards).toHaveCount(1);

  // Dismiss the other.
  // A tip card sits over the corner of the screen, so the button is reached by keyboard.
  await cards.first().getByRole("button", { name: "Dismiss" }).focus();
  await page.keyboard.press("Enter");
  await expect(cards).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Notes (1)" })).toBeVisible();
});

test("a changed image shows old and new, and the swipe slider works by keyboard", async ({ page, openApp }) => {
  await openApp();
  await page.evaluate(([wt]) => (window as unknown as { xdevMock: Mock }).xdevMock.__addChange(wt, { path: "assets/logo.png", kind: "modified" }), [OAK]);
  await openReview(page, "assets/logo.png");

  const file = page.locator('.rv-file[data-path="assets/logo.png"]');
  await expect(file.getByRole("img", { name: "logo.png, old version" })).toBeVisible({ timeout: 15_000 });
  await expect(file.getByRole("img", { name: "logo.png, new version" })).toBeVisible();
  // Size and dimensions of each side.
  await expect(file.getByText("2 × 2")).toBeVisible();
  await expect(file.getByText("1 × 1")).toBeVisible();

  const modes = file.getByRole("group", { name: "Image view" });
  await modes.getByRole("button", { name: "Swipe" }).click();
  await expect(modes.getByRole("button", { name: "Swipe" })).toHaveAttribute("aria-pressed", "true");
  const slider = file.getByRole("slider", { name: "Swipe position" });
  await slider.focus();
  await expect(slider).toHaveValue("50");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await expect(slider).toHaveValue("52");
  await page.keyboard.press("End");
  await expect(slider).toHaveValue("100");

  await modes.getByRole("button", { name: "Onion skin" }).click();
  const opacity = file.getByRole("slider", { name: "Opacity of the new image" });
  await opacity.focus();
  await page.keyboard.press("Home");
  await expect(opacity).toHaveValue("0");
});

test("the review screen with an image and AI findings fits at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await page.evaluate(([wt]) => (window as unknown as { xdevMock: Mock }).xdevMock.__addChange(wt, { path: "assets/logo.png", kind: "modified" }), [OAK]);
  await openReview(page, "assets/logo.png");
  await expect(page.locator('.rv-file[data-path="assets/logo.png"]').getByRole("img", { name: "logo.png, new version" })).toBeVisible({ timeout: 15_000 });
  // The side panel covers the bar at this width, so the button is reached by keyboard.
  await page.getByRole("button", { name: "Review with AI" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "AI review done" })).toBeVisible({ timeout: 15_000 });
  expect(await fitsWidth(page)).toBe(true);
});
