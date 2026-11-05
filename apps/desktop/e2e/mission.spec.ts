import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./fixtures";

/** Runs a command from the command palette. */
async function runCommand(page: Page, command: string): Promise<void> {
  await expect(page.getByRole("tree", { name: "Files of this worktree" })).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill(command);
  await palette.getByRole("option", { name: command }).click();
}

/** Opens Mission Control from the command palette. */
async function openMission(page: Page, command = "Open Mission Control"): Promise<Locator> {
  await runCommand(page, command);
  const mission = page.getByRole("dialog", { name: "Mission Control" });
  await expect(mission).toBeVisible();
  return mission;
}

test("Mission Control shows a stuck worker and records a nudge", async ({ page, openApp }) => {
  await openApp();
  const mission = await openMission(page);
  const builder = mission.getByRole("listitem", { name: "Builder" });
  await expect(builder).toContainText("Stuck: no output");
  await expect(builder).toContainText("Task: Add retry to fetchJson");
  await expect(mission.getByRole("listitem", { name: "Reviewer" })).toContainText("Stuck: waiting on you");
  await builder.getByRole("button", { name: "Nudge Builder" }).click();
  await expect(mission.getByRole("status")).toHaveText("Nudge sent to Builder.");
  await expect(builder).toContainText("Nudged just now");
});

test("linked tabs show on the team map with both grants off, and a transcript grant persists", async ({ page, openApp }) => {
  await openApp();
  let mission = await openMission(page);
  const lead = mission.getByRole("listitem", { name: "Lead" });
  await lead.getByRole("combobox", { name: "Let Lead read another tab" }).selectOption({ label: "Reviewer" });
  await expect(mission.getByRole("status")).toHaveText("Lead may now read Reviewer. Both grants are off.");
  const transcript = lead.getByRole("switch", { name: "Allow Transcript of Reviewer" });
  const screen = lead.getByRole("switch", { name: "Allow Screen of Reviewer" });
  await expect(transcript).not.toBeChecked();
  await expect(screen).not.toBeChecked();

  await mission.getByRole("tab", { name: "Team map" }).click();
  await expect(mission.getByTestId("edge-demo-lead-demo-review")).toContainText("no grants");
  await expect(mission.getByRole("button", { name: "Lead, focus tab" })).toBeVisible();

  await mission.getByRole("tab", { name: "Tabs" }).click();
  await transcript.check();
  await expect(mission.getByRole("status")).toHaveText("Transcript of Reviewer is on for Lead.");
  await mission.getByRole("button", { name: "Close" }).click();
  await expect(mission).toBeHidden();

  mission = await openMission(page, "Show team map");
  await expect(mission.getByTestId("edge-demo-lead-demo-review")).toContainText("Transcript");
  await mission.getByRole("tab", { name: "Tabs" }).click();
  await expect(mission.getByRole("listitem", { name: "Lead" }).getByRole("switch", { name: "Allow Transcript of Reviewer" })).toBeChecked();
});

test("the team map is usable from the keyboard", async ({ page, openApp }) => {
  await openApp();
  const mission = await openMission(page, "Show team map");
  const lead = mission.getByRole("button", { name: "Lead, focus tab" });
  await lead.focus();
  await page.keyboard.press("ArrowRight");
  await expect(mission.getByRole("button", { name: "Builder, focus tab" })).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(lead).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(mission).toBeHidden();
});

test("a hand-off picks a live tab with @ and the keyboard", async ({ page, openApp }) => {
  await openApp();
  await runCommand(page, "Hand off to a tab");
  const dialog = page.getByRole("dialog", { name: "Hand off to a tab" });
  await dialog.getByRole("combobox", { name: "From tab" }).selectOption({ label: "Lead" });
  const message = dialog.getByRole("combobox", { name: "Message" });
  await message.click();
  await page.keyboard.type("@Rev");
  const list = dialog.getByRole("listbox", { name: "Live tabs" });
  await expect(list.getByRole("option", { name: "Reviewer" })).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(message).toHaveValue("@Reviewer ");
  await expect(list).toBeHidden();
  await page.keyboard.type("please review the retry change");
  await expect(dialog).toContainText("Goes to Reviewer.");
  await dialog.getByRole("button", { name: "Hand off" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Handed off to Reviewer.")).toBeVisible();
});
