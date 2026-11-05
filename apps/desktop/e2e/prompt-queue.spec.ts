import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

async function dismissTip(page: Page) {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

async function openComposer(page: Page) {
  await page.getByTestId("composer-launch").click();
  // The dialog's name follows the view (compose, schedule, queue), so find it by its close button.
  const composer = page.getByRole("dialog").filter({ has: page.getByRole("button", { name: "Close the composer" }) });
  await expect(composer).toBeVisible();
  return composer;
}

/** Types a prompt and queues it with the Schedule form's current choice. */
async function schedule(composer: Locator, text: string, pick: (form: Locator) => Promise<void>) {
  await composer.getByRole("combobox", { name: "Prompt" }).fill(text);
  await composer.getByRole("button", { name: "Schedule…" }).click();
  const form = composer.getByTestId("composer-schedule");
  await expect(form).toBeVisible();
  await pick(form);
  await form.getByRole("button", { name: "Add to queue" }).click();
  await expect(composer.getByRole("status").filter({ hasText: "Queued" })).toBeVisible();
}

test("two prompts queued for 0 minutes are sent in order", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  const composer = await openComposer(page);

  const now = async (form: Locator) => {
    await form.getByRole("radio", { name: "In some minutes" }).check();
    await form.getByLabel("Minutes from now").fill("0");
  };
  await schedule(composer, "echo first", now);
  await schedule(composer, "echo second", now);

  // Both go, one after the other. The terminal is a canvas, so the order is read off the queue as it
  // drains: "echo first" leaves before "echo second", never the other way round.
  await composer.getByTestId("composer-queue-open").click();
  const rows = composer.getByTestId("composer-queue-item");
  await expect(rows).toHaveCount(2);
  const seen: string[] = [];
  await expect
    .poll(
      async () => {
        const texts = (await rows.allInnerTexts()).map((x) => (x.includes("echo first") ? "first" : "second"));
        seen.push(texts.join("+") || "none");
        return texts.length;
      },
      { timeout: 30_000, intervals: [100] },
    )
    .toBe(0);
  expect(seen).not.toContain("second+first");
  expect(seen).not.toContain("first");
  expect(seen).toContain("second");
  await expect(composer.getByText("Nothing is queued for this tab.")).toBeVisible();
});

test("a prompt queued for after the quota reset waits and shows the reset time", async ({ page, openApp }) => {
  await openApp();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.locator(".xterm")).toBeVisible();
  const composer = await openComposer(page);

  await schedule(composer, "echo later", async (form) => {
    await form.getByRole("radio", { name: "After the quota resets" }).check();
    await expect(form.getByTestId("composer-reset-hint")).toContainText("The 5-hour window resets at");
  });

  const open = composer.getByTestId("composer-queue-open");
  await expect(open).toHaveText("Queue (1)");
  await open.click();
  const row = composer.getByTestId("composer-queue-item");
  await expect(row).toHaveCount(1);
  await expect(row).toContainText("echo later");
  await expect(row).toContainText("After the quota resets,");
  await expect(row).toContainText("Waiting");
  // Still waiting a few ticks later: the reset is hours away.
  await page.waitForTimeout(2_500);
  await expect(row).toContainText("Waiting");

  // Its controls are named and reachable from the keyboard; delete empties the queue.
  await row.getByRole("button", { name: /^Delete: / }).focus();
  await page.keyboard.press("Enter");
  await expect(composer.getByTestId("composer-queue-status")).toContainText("Deleted");
  await expect(composer.getByText("Nothing is queued for this tab.")).toBeVisible();
});

test("at 360px the queue and the schedule form stay inside the window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await openApp();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await dismissTip(page);
  await page.getByRole("button", { name: "PowerShell" }).click();
  const composer = await openComposer(page);
  await composer.getByRole("combobox", { name: "Prompt" }).fill("echo later");
  await composer.getByRole("button", { name: "Schedule…" }).click();
  await composer.getByRole("radio", { name: "After the quota resets" }).check();
  expect(await fitsWidth(page)).toBe(true);
  await composer.getByRole("button", { name: "Add to queue" }).click();
  await composer.getByTestId("composer-queue-open").click();
  await expect(composer.getByTestId("composer-queue-item")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
