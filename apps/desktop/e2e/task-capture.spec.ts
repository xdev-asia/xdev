import type { Page } from "@playwright/test";
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

/** Runs "New task" from the command palette. */
async function openNewTask(page: Page) {
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("New task");
  await palette.getByRole("option", { name: "New task" }).click();
  const editor = page.getByRole("dialog", { name: "New task" });
  await expect(editor).toBeVisible();
  return editor;
}

test("create a task from the palette, and the editor fits at 360px", async ({ page, openApp }) => {
  await openApp();
  const before = (await boardFiles(page)).length;
  const editor = await openNewTask(page);
  await editor.getByRole("textbox", { name: "Title" }).fill("Fix the login redirect");
  await editor.getByRole("textbox", { name: "Labels" }).fill("auth, bug");
  await editor.getByRole("button", { name: "Save task" }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByRole("status").filter({ hasText: "Task saved" })).toBeVisible();

  const files = await boardFiles(page);
  expect(files).toHaveLength(before + 1);
  const made = files.find((f) => f.text.includes("title: Fix the login redirect"));
  expect(made?.file).toMatch(/^\.xdev\/tasks\/t[a-z2-7]{6}\.md$/);
  expect(made?.text).toContain("labels: [auth, bug]");

  await page.setViewportSize({ width: 360, height: 740 });
  const again = await openNewTask(page);
  expect(await fitsWidth(page)).toBe(true);
  await expect(again.getByRole("button", { name: "Save task" })).toBeVisible();
});

test("an empty title is refused and nothing is written", async ({ page, openApp }) => {
  await openApp();
  const before = (await boardFiles(page)).length;
  const editor = await openNewTask(page);
  await editor.getByRole("button", { name: "Save task" }).click();
  await expect(editor.getByText("Enter a title.")).toBeVisible();
  expect(await boardFiles(page)).toHaveLength(before);
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
});
