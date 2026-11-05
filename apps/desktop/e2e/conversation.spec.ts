import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = { __hook(id: string, event: string, detail?: unknown, session?: string): void };

/** The first-run tip card sits over the bottom-right corner, where the launcher is. */
async function dismissTip(page: Page): Promise<void> {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

/** Starts a Claude tab, gives it a session id and returns its tab id. */
async function startAgent(page: Page): Promise<string> {
  await dismissTip(page);
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Allow and start" }).click();
  const tab = page.locator('.ws-tab[data-selected="true"]');
  await expect(tab).toBeVisible();
  const id = (await tab.getAttribute("data-tab-id"))!;
  // No session yet: nothing to read.
  await expect(page.getByTestId("conversation-button")).toHaveCount(0);
  await page.evaluate((tab) => (window as unknown as { xdevMock: Mock }).xdevMock.__hook(tab, "prompt", undefined, "sess-convo"), id);
  return id;
}

test("an agent tab shows its conversation as bubbles with folded tool steps, then as a document", async ({ page, openApp }) => {
  // Wide enough for a pane of 900px beside the sidebar: the view sits beside the terminal.
  await page.setViewportSize({ width: 1600, height: 900 });
  await openApp();
  await startAgent(page);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();

  const view = page.getByRole("region", { name: "Conversation of Claude Code" });
  await expect(view).toBeVisible();
  await expect(page.getByTestId("conversation-dock")).toHaveAttribute("data-mode", "split");
  await expect(view.locator('.cv-msg[data-role="user"]').first()).toContainText("Fix the date format");
  await expect(view.locator('.cv-msg[data-role="assistant"]').first()).toContainText("I will read the formatter first");
  await expect(view.getByRole("group", { name: "Session" })).toContainText("2 turns");
  await expect(view.getByRole("group", { name: "Session" })).toContainText("Conversation compacted");

  // A run of three steps is one row until it is opened.
  const run = view.getByRole("button", { name: /3 tool steps/ });
  await expect(run).toHaveAttribute("aria-expanded", "false");
  await expect(view.locator(".cv-step")).toHaveCount(0);
  await run.click();
  await expect(run).toHaveAttribute("aria-expanded", "true");
  await expect(view.locator(".cv-step")).toHaveCount(3);
  await expect(view.locator('.cv-step[data-status="error"]')).toContainText("pnpm test -- format");

  // A path the worktree does not hold copies; a link opens its menu.
  await expect(view.getByRole("button", { name: "Copy path /tmp/xdev-test.log" })).toBeVisible();
  // By keyboard: the menu closes on any scroll, and a click scrolls the button into view first.
  const link = view.getByRole("button", { name: "date docs" });
  await link.scrollIntoViewIfNeeded();
  await expect(link).toBeInViewport();
  await link.press("Enter");
  await expect(page.getByRole("menuitem", { name: "Open in browser" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitem", { name: "Open in browser" })).toHaveCount(0);
  // Escape closed the menu only, and focus went back to the link.
  await expect(view).toBeVisible();
  await expect(link).toBeFocused();

  // Reader: user turns are headings, tool steps behind one switch.
  await view.getByRole("button", { name: "Reader", exact: true }).click();
  await expect(view.getByRole("heading", { name: "Good. Also update README.md" })).toBeVisible();
  await expect(view.locator(".cv-bubble")).toHaveCount(0);
  await expect(view.locator(".cv-step")).toHaveCount(0);
  await view.getByRole("switch", { name: "Show tool steps" }).check();
  await expect(view.locator(".cv-step")).toHaveCount(4);

  // Text size, kept for the next open.
  const section = page.locator("section.cv");
  await expect(section).toHaveAttribute("data-size", "medium");
  await view.getByRole("button", { name: "Larger text" }).click();
  await expect(section).toHaveAttribute("data-size", "large");
  await expect(view.getByRole("button", { name: "Larger text" })).toBeDisabled();

  // Escape gives the keyboard back to the terminal.
  await view.getByRole("button", { name: "Smaller text" }).focus();
  await page.keyboard.press("Escape");
  await expect(view).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
  await page.getByRole("button", { name: "Conversation", exact: true }).click();
  await expect(page.locator("section.cv")).toHaveAttribute("data-view", "reader");
  await expect(page.locator("section.cv")).toHaveAttribute("data-size", "large");
});

test("at 360px the conversation opens from the palette over the terminal and fits", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await startAgent(page);

  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Open conversation");
  await palette.getByRole("option", { name: "Open conversation" }).click();

  const view = page.getByRole("region", { name: "Conversation of Claude Code" });
  await expect(view).toBeVisible();
  await expect(page.getByTestId("conversation-dock")).toHaveAttribute("data-mode", "full");
  await expect(view.locator(".cv-bubble").first()).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await view.getByRole("button", { name: "Reader", exact: true }).click();
  await expect(view.getByRole("heading", { name: "Good. Also update README.md" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);

  await view.getByRole("button", { name: "Back to terminal" }).click();
  await expect(view).toHaveCount(0);
  await expect(page.locator(".xterm-helper-textarea:focus")).toHaveCount(1);
});
