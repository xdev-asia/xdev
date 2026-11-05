import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = {
  __attributionTouch(worktree: string, path: string, who: { tabId: string; agent: string } | null, content: string): Promise<void>;
  fileRead(worktree: string, rel: string): Promise<{ text: string | null }>;
};
const OAK = "/demo/wt/xdev-oak";
const FILE = "src/session.ts";
const CLAUDE = { tabId: "tab-claude-1111", agent: "claude" };
const CODEX = { tabId: "tab-codex-2222", agent: "codex" };

/** Two mock tabs write `FILE` one after the other: claude first, codex second. */
async function twoTabsTouch(page: Page): Promise<void> {
  await page.evaluate(
    async ([wt, file, claude, codex]) => {
      const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
      await mock.__attributionTouch(wt as string, file as string, claude as typeof CLAUDE, "export const value = 1;\n");
      await mock.__attributionTouch(wt as string, file as string, codex as typeof CODEX, "export const value = 2;\n");
    },
    [OAK, FILE, CLAUDE, CODEX],
  );
}

/** Opens the review tab of the demo worktree `oak` from its Changes list, on `file`. */
async function openReview(page: Page, file: string): Promise<void> {
  await page.getByRole("button", { name: /^oak/ }).first().click();
  // At 360px the sidebar covers the panels until it is hidden.
  if ((page.viewportSize()?.width ?? 1280) < 600) {
    const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
    if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  }
  await page.getByRole("tab", { name: /^Changes/ }).click();
  await page.getByRole("tabpanel").getByText(file, { exact: true }).first().click();
  await expect(page.getByRole("tab", { name: "Review" })).toBeVisible();
  await expect(page.locator(`.rv-file[data-path="${file}"]`)).toBeVisible();
}

test("a file two tabs changed shows both chips and the badge; a version is restored after a confirm", async ({ page, openApp }) => {
  await openApp();
  await twoTabsTouch(page);
  await openReview(page, FILE);

  const file = page.locator(`.rv-file[data-path="${FILE}"]`);
  const chips = file.getByRole("group", { name: "Changed by" });
  await expect(chips.getByText("claude", { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(chips.getByText("codex", { exact: true })).toBeVisible();
  await expect(file.getByText("Touched by 2 agents")).toBeVisible();

  // The filter keeps the files several agents touched.
  const filter = page.getByRole("button", { name: /Touched by several agents/ });
  await filter.click();
  await expect(filter).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(`.rv-list-item[data-path="${FILE}"]`)).toBeVisible();
  await expect(page.locator(".rv-list-item")).toHaveCount(1);
  await filter.click();
  await expect(page.locator(".rv-list-item")).not.toHaveCount(1);

  // The Live panel lists the latest changes, newest first.
  await page.getByRole("button", { name: "Live", exact: true }).click();
  const live = page.getByRole("region", { name: "Latest changes by agents" });
  await expect(live.getByRole("button")).toHaveCount(2);
  await expect(live.getByRole("button").first()).toContainText(FILE);
  await page.getByRole("button", { name: "Live", exact: true }).click();

  // Versions: newest first. The older one is claude's.
  await file.getByRole("button", { name: "Versions" }).click();
  const dialog = page.getByRole("dialog", { name: `Versions of ${FILE}` });
  const versions = dialog.getByRole("list", { name: "Versions an agent wrote" }).getByRole("button");
  await expect(versions).toHaveCount(2);
  await expect(versions.nth(0)).toContainText("codex");
  await versions.nth(1).click();
  await expect(dialog.getByRole("region", { name: "Version against the current file" })).toBeVisible();

  // Restore asks first; Cancel leaves the file alone.
  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  const confirm = page.getByRole("alertdialog", { name: `Restore this version of ${FILE}?` });
  await expect(confirm).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(await page.evaluate(async ([wt, f]) => (await (window as unknown as { xdevMock: Mock }).xdevMock.fileRead(wt, f)).text, [OAK, FILE])).toBe("export const value = 2;\n");

  await dialog.getByRole("button", { name: "Restore", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Restore version" }).click();
  await expect(dialog.getByRole("status").filter({ hasText: `Restored ${FILE}.` })).toBeAttached();
  expect(await page.evaluate(async ([wt, f]) => (await (window as unknown as { xdevMock: Mock }).xdevMock.fileRead(wt, f)).text, [OAK, FILE])).toBe("export const value = 1;\n");

  // Esc closes the list and focus goes back to the button that opened it.
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(file.getByRole("button", { name: "Versions" })).toBeFocused();
});

test("a change that arrives while the review is open updates the chips without a reload", async ({ page, openApp }) => {
  await openApp();
  await openReview(page, FILE);
  const file = page.locator(`.rv-file[data-path="${FILE}"]`);
  await expect(file.getByRole("group", { name: "Changed by" })).toHaveCount(0);
  await twoTabsTouch(page);
  // Reads are at least two seconds apart, so the chips may take that long.
  await expect(file.getByText("Touched by 2 agents")).toBeVisible({ timeout: 10_000 });
});

test("the attribution parts fit at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await twoTabsTouch(page);
  await openReview(page, FILE);
  const file = page.locator(`.rv-file[data-path="${FILE}"]`);
  await expect(file.getByText("Touched by 2 agents")).toBeVisible({ timeout: 10_000 });
  expect(await fitsWidth(page)).toBe(true);
  // A tip card may sit over the corner, so the buttons are reached by keyboard.
  await page.getByRole("button", { name: "Live", exact: true }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Latest changes by agents" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await file.getByRole("button", { name: "Versions" }).focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: `Versions of ${FILE}` })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
