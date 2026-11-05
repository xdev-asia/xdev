import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

/** Opens "Terminals on this machine" from the command palette. */
async function openTerminals(page: Page): Promise<Locator> {
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("Terminals on this machine");
  await palette.getByRole("option", { name: "Terminals on this machine" }).click();
  const dialog = page.getByRole("dialog", { name: "Terminals on this machine" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("lists a foreign agent CLI and resumes its session here", async ({ page, openApp }) => {
  await openApp();
  await expect(page.getByRole("tree", { name: "Files of this worktree" })).toBeVisible();
  // The mock index titles that session from its first prompt.
  const resumed = page.getByRole("tab", { name: /^Fix the parser test on Windows paths/ });
  await expect(resumed).toHaveCount(0);
  const dialog = await openTerminals(page);
  await expect(dialog.getByRole("status")).toHaveText("3 terminals found");
  const row = dialog.getByRole("listitem", { name: "Claude Code, pid 48211" });
  await expect(row).toContainText("Terminal");
  await expect(row).toContainText("/demo/xdev");
  await expect(dialog.getByRole("button", { name: /^Resume the session of zsh/ })).toHaveCount(0);
  await row.getByRole("button", { name: "Resume the session of Claude Code here" }).click();
  await expect(dialog).toBeHidden();
  await expect(resumed).toHaveAttribute("aria-selected", "true");
});

test("the list fits a 360px window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();
  const dialog = await openTerminals(page);
  await expect(dialog.getByRole("listitem", { name: "Claude Code, pid 48211" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
});
