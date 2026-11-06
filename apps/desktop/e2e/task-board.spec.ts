import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type BoardMock = {
  workspaceList(): Promise<{ path: string }[]>;
  __boardFiles(repo: string): { file: string; text: string }[];
};

/** The files of the first repo's board, as the mock writes them. */
async function boardFiles(page: Page): Promise<{ file: string; text: string }[]> {
  return page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: BoardMock }).xdevMock;
    const [repo] = await mock.workspaceList();
    return mock.__boardFiles(repo.path);
  });
}

/** Runs "Open task board" from the command palette. */
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

const column = (board: Locator, name: string): Locator => board.locator(".x-board-col").filter({ has: board.page().getByRole("heading", { name, exact: false }) });
const card = (board: Locator, title: string): Locator => board.locator(".x-board-card").filter({ hasText: title });

/** Drags the card by its title to the middle of a column. */
async function dragTo(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + a.width / 2 + 20, a.y + a.height / 2 + 20, { steps: 3 });
  await page.mouse.move(b.x + b.width / 2, b.y + 60, { steps: 8 });
  await page.mouse.up();
}

test("the Tasks app shows five columns with the seeded cards in the right ones", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  const names = ["Backlog", "To do", "In progress", "In review", "Done"];
  await expect(board.locator(".x-board-col")).toHaveCount(5);
  for (const [i, name] of names.entries()) await expect(board.locator(".x-board-col").nth(i).getByRole("heading")).toHaveText(name);
  await expect(column(board, "Backlog")).toContainText("Plan the offline sync");
  await expect(column(board, "To do")).toContainText("Fix the login redirect loop");
  await expect(column(board, "In progress")).toContainText("Polish the settings page");
  await expect(column(board, "In review")).toContainText("Document the release steps");
  await expect(column(board, "Done")).toContainText("Rotate the signing key");
  await expect(board.getByText("Could not read 1 task files")).toBeVisible();
});

test("drag a card from To do to In review, and the file says so", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  await dragTo(page, card(board, "Fix the login redirect loop"), column(board, "In review"));
  await expect(column(board, "In review")).toContainText("Fix the login redirect loop");
  await expect(column(board, "To do")).not.toContainText("Fix the login redirect loop");
  await expect.poll(async () => (await boardFiles(page)).find((f) => f.text.includes("title: Fix the login redirect loop"))?.text).toContain("status: in-review");
});

test("a focused card moves with Alt+ArrowRight and the change is announced", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  await card(board, "Plan the offline sync").focus();
  await page.keyboard.press("Alt+ArrowRight");
  await expect(column(board, "To do")).toContainText("Plan the offline sync");
  await expect(board.getByRole("status").filter({ hasText: "Moved Plan the offline sync to To do" })).toBeAttached();
});

test("filter by label auth, then Clear filters brings the rest back", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  await board.getByRole("group", { name: "Label" }).getByRole("button", { name: "auth" }).click();
  await expect(board.locator(".x-board-card")).toHaveCount(2);
  await expect(board.locator(".x-board-card").filter({ hasText: "Rotate the signing key" })).toBeVisible();
  await expect(board.locator(".x-board-card").filter({ hasText: "Plan the offline sync" })).toHaveCount(0);
  await board.getByRole("button", { name: "Clear filters" }).click();
  await expect(board.locator(".x-board-card")).toHaveCount(5);
});

test("the List view sorts by priority", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  await page.getByRole("tab", { name: "List" }).click();
  const list = page.getByRole("tabpanel", { name: "List" });
  const titles = () => list.locator("tbody tr td:first-child").allInnerTexts();
  // The default order is priority, so the p0 task comes first.
  expect((await titles())[0]).toBe("Rotate the signing key");
  await list.getByRole("button", { name: "Priority" }).click();
  expect((await titles())[0]).toBe("Rotate the signing key");
  await list.getByRole("button", { name: "Priority" }).click();
  expect((await titles())[0]).toBe("Plan the offline sync");
  await expect(board).toBeHidden();
});

test("start an agent on a task in a new worktree, and the card shows where it works", async ({ page, openApp }) => {
  await openApp();
  const board = await openBoard(page);
  const target = card(board, "Fix the login redirect loop");
  await target.getByRole("button", { name: /^Actions for/ }).click();
  await page.getByRole("menuitem", { name: "Start agent" }).click();
  const dialog = page.getByRole("dialog", { name: "Start an agent on this task" });
  await expect(dialog.getByRole("radio", { name: "New worktree" })).toBeChecked();
  await dialog.getByRole("button", { name: "Start", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(target).toContainText("Working in");
  await expect(column(board, "In progress")).toContainText("Fix the login redirect loop");
  await target.getByRole("button", { name: "Open tab" }).click();
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
});

test("a repo with no tasks shows the empty state", async ({ page, openApp }) => {
  await openApp("?board=empty");
  const board = await openBoard(page);
  await expect(board.getByText("No tasks in this repo yet")).toBeVisible();
  await expect(board.getByRole("button", { name: "New task" })).toBeVisible();
  await expect(board.getByRole("button", { name: "Split a goal into tasks" })).toBeVisible();
});

test("Board and List fit at 360px", async ({ page, openApp }) => {
  await openApp();
  await page.setViewportSize({ width: 360, height: 740 });
  const board = await openBoard(page);
  // At 360px the workspace sidebar covers the apps until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await expect(board.locator(".x-board-col")).toHaveCount(5);
  expect(await fitsWidth(page)).toBe(true);
  // The columns scroll inside their own box.
  expect(await board.locator(".x-board").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
  await page.getByRole("tab", { name: "List" }).click();
  await expect(page.getByRole("tabpanel", { name: "List" }).getByRole("table")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
