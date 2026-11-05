import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

type Mock = { __hook(id: string, event: string, detail?: unknown, session?: string): void; __contextUsage(session: string, usage: unknown): void };
declare global {
  interface Window {
    xdevMock: Mock;
  }
}

/** Starts a Claude tab in the empty worktree and returns its tab id. */
async function startAgent(page: Page): Promise<string> {
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Allow and start" }).click();
  const tab = page.locator('.ws-tab[data-selected="true"]');
  await expect(tab).toBeVisible();
  return (await tab.getAttribute("data-tab-id"))!;
}

test("a busy agent tab shows the run timer, then keeps its length when it goes idle", async ({ page, openApp }) => {
  await openApp();
  const id = await startAgent(page);
  const chips = page.locator(".pane-chips");
  const timer = chips.locator('[data-chip="timer"]');
  // A hooked agent counts as working from its start until its first turn ends.
  await expect(timer).toHaveAttribute("aria-label", /^Agent working for/);
  await page.evaluate((tab) => window.xdevMock.__hook(tab, "turn-done"), id);
  await expect(timer).toHaveAttribute("aria-label", /^Last run took/, { timeout: 8000 });

  await page.evaluate((tab) => window.xdevMock.__hook(tab, "prompt", undefined, "sess-e2e"), id);
  await expect(timer).toBeVisible();
  await expect(timer).toHaveAttribute("aria-label", /^Agent working for \d+:\d\d$/);
  // The clock ticks: it moves past 0:00 within a few seconds.
  await expect(timer).not.toHaveAttribute("aria-label", "Agent working for 0:00", { timeout: 5000 });

  await page.evaluate((tab) => window.xdevMock.__hook(tab, "turn-done"), id);
  await expect(timer).toHaveAttribute("aria-label", /^Last run took \d+:\d\d$/, { timeout: 8000 });
  await expect(chips.getByRole("status")).toHaveText(/^Run finished after \d+:\d\d$/);
});

test("the context chip shows once the transcript is readable and hides when it is not", async ({ page, openApp }) => {
  await openApp();
  const id = await startAgent(page);
  const chips = page.locator(".pane-chips");
  await page.evaluate(() => window.xdevMock.__contextUsage("sess-ctx", { tokens: 45005, window: 200000, model: "claude-sonnet-5-5" }));
  await page.evaluate((tab) => window.xdevMock.__hook(tab, "prompt", undefined, "sess-ctx"), id);
  const context = chips.locator('[data-chip="context"]');
  await expect(context).toHaveAttribute("aria-label", "Context window: 45,005 of 200,000 tokens used (23%)");
  await expect(chips.locator('[data-chip="quota"]')).toBeVisible();
});

test("a chip turns off from the terminal menu", async ({ page, openApp }) => {
  await openApp();
  const id = await startAgent(page);
  await page.evaluate((tab) => window.xdevMock.__hook(tab, "prompt"), id);
  const timer = page.locator('.pane-chips [data-chip="timer"]');
  await expect(timer).toBeVisible();
  // Right click pastes by default off macOS; Shift+right click opens the menu.
  await page.locator(".xterm").click({ button: "right", modifiers: ["Shift"] });
  await page.getByRole("menuitem", { name: "Header chips" }).click();
  await page.getByRole("menuitemradio", { name: "Run timer" }).click();
  await expect(timer).toHaveCount(0);
});

test("a note written on a tab shows a dot on the tab and is sent to its terminal", async ({ page, openApp }) => {
  await openApp();
  const id = await startAgent(page);
  const tab = page.locator(`.ws-tab[data-tab-id="${id}"]`);
  await expect(tab.getByRole("img", { name: "Has a note" })).toHaveCount(0);

  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Sticky note…" }).click();
  const dialog = page.getByRole("dialog", { name: "Note for Claude Code" });
  await dialog.getByRole("textbox", { name: "Note" }).fill("# Plan\n- check the parser test");
  await expect(dialog.getByRole("region", { name: "Preview" })).toContainText("check the parser test");
  await dialog.getByRole("button", { name: "Save" }).click();
  await expect(dialog).toBeHidden();
  await expect(tab.getByRole("img", { name: "Has a note" })).toBeVisible();

  // The header button opens it again and sends it.
  await page.getByRole("button", { name: "Sticky note, has text" }).click();
  await expect(dialog.getByRole("textbox", { name: "Note" })).toHaveValue(/check the parser test/);
  await dialog.getByRole("button", { name: "Send to agent" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Note typed into Claude Code")).toBeVisible();

  // The library lists it with its tab and worktree, and search narrows it.
  await tab.click({ button: "right" });
  await page.getByRole("menuitem", { name: "All notes…" }).click();
  const library = page.getByRole("dialog", { name: "Notes" });
  await expect(library.getByRole("list", { name: "Notes" }).getByRole("listitem")).toHaveCount(1);
  await expect(library).toContainText("Claude Code");
  await library.getByRole("searchbox", { name: "Search notes" }).fill("nothing like it");
  await expect(library).toContainText("No notes match.");
  await library.getByRole("searchbox", { name: "Search notes" }).fill("parser");
  await library.getByRole("button", { name: "Delete note for Claude Code" }).click();
  await expect(library).toContainText("No notes yet.");
  await library.getByRole("button", { name: "Close" }).click();
  await expect(tab.getByRole("img", { name: "Has a note" })).toHaveCount(0);
});

test("Escape closes the note dialog and keeps nothing", async ({ page, openApp }) => {
  await openApp();
  await startAgent(page);
  const button = page.getByRole("button", { name: "Sticky note", exact: true });
  await button.click();
  const dialog = page.getByRole("dialog", { name: "Note for Claude Code" });
  await dialog.getByRole("textbox", { name: "Note" }).fill("draft");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("button", { name: "Sticky note", exact: true })).toBeVisible();
});
