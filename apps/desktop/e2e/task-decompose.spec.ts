import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type BoardMock = {
  workspaceList(): Promise<{ path: string }[]>;
  __boardFiles(repo: string): { file: string; text: string }[];
};

async function boardFiles(page: Page): Promise<{ file: string; text: string }[]> {
  return page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: BoardMock }).xdevMock;
    const [repo] = await mock.workspaceList();
    return mock.__boardFiles(repo.path);
  });
}

async function openBoard(page: Page): Promise<Locator> {
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("Open task board");
  await palette.getByRole("option", { name: "Open task board" }).click();
  const board = page.getByRole("tabpanel", { name: "Board" });
  await expect(board).toBeVisible();
  return board;
}

async function ask(page: Page, goal: string): Promise<Locator> {
  await page.getByRole("button", { name: "Split a goal into tasks" }).click();
  const dialog = page.getByRole("dialog", { name: "Split a goal into tasks" });
  await expect(dialog.getByRole("button", { name: "Ask agent" })).toBeDisabled();
  await dialog.getByRole("textbox", { name: "Goal" }).fill(goal);
  await dialog.getByRole("button", { name: "Ask agent" }).click();
  return dialog;
}

test("a goal becomes tasks: review, uncheck one, write the rest", async ({ page, openApp }) => {
  await openApp("?board=empty");
  const board = await openBoard(page);
  expect(await boardFiles(page)).toHaveLength(0);
  const dialog = await ask(page, "Add offline sync");
  await expect(dialog.getByRole("checkbox")).toHaveCount(3, { timeout: 5000 });
  await expect(dialog.getByRole("heading", { name: "Review 3 tasks before they are written" })).toBeVisible();
  expect(await boardFiles(page)).toHaveLength(0);
  await dialog.getByRole("checkbox").nth(1).uncheck();
  await dialog.getByRole("button", { name: "Write 2 tasks" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(async () => (await boardFiles(page)).length).toBe(2);
  await expect(board.locator(".x-board-card")).toHaveCount(2);
});

test("an answer that is not a task list shows a banner and writes nothing", async ({ page, openApp }) => {
  await openApp("?board=empty");
  await openBoard(page);
  const dialog = await ask(page, "Add offline sync !bad");
  await expect(dialog.getByText("The agent's answer was not a task list. Nothing was written.")).toBeVisible({ timeout: 5000 });
  await expect(dialog.getByRole("button", { name: "Ask agent" })).toBeEnabled();
  expect(await boardFiles(page)).toHaveLength(0);
});

test("the review step fits at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp("?board=empty");
  await openBoard(page);
  // At 360px the workspace sidebar covers the board until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  const dialog = await ask(page, "Add offline sync");
  await expect(dialog.getByRole("checkbox")).toHaveCount(3, { timeout: 5000 });
  expect(await fitsWidth(page)).toBe(true);
  const box = (await dialog.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
});
