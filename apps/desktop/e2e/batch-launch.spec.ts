import { expect, test } from "./fixtures";

// The mock backend answers every spawn, so tabs open and stay open.
test("launch 3 copies, save them as a set, close them and open the set again", async ({ page, openApp }) => {
  await openApp();
  const tabs = page.getByRole("tab", { name: /^Claude Code/ });
  // The new tab button shows once a first tab is open.
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.getByRole("tab", { name: "PowerShell" })).toBeVisible();

  // Launch with options: a count of 3 opens three tabs of the same agent.
  await page.getByRole("button", { name: "New tab" }).click();
  // The terminal canvas covers the menu in this layout, so the item is reached by keyboard.
  await page.getByRole("menuitem", { name: "Launch with options" }).focus();
  await page.keyboard.press("Enter");
  await page.getByRole("combobox", { name: "Agents" }).fill("Claude");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  const launch = page.getByRole("dialog", { name: "Launch Claude Code with options" });
  await launch.getByLabel("Copies").fill("3");
  await launch.getByRole("button", { name: "Launch 3 copies" }).click();
  await expect(launch).toBeHidden();
  await expect(tabs).toHaveCount(3, { timeout: 15_000 });
  await expect(page.getByRole("status").filter({ hasText: "Opened 3 tabs" })).toBeVisible({ timeout: 15_000 });

  // The mock policy asks before starting an agent; allow it once so later launches do not ask.
  const ask = page.getByRole("dialog", { name: "Delete this session?" });
  for (let i = 0; i < 3 && (await ask.isVisible()); i++) await ask.getByRole("button", { name: "Allow and start" }).press("Enter");

  // Save the open tabs as a set from the agent picker.
  const openSets = async () => {
    await page.getByRole("button", { name: "New tab" }).click();
    await page.getByRole("menuitem", { name: "Agent…" }).focus();
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "Terminal sets" }).focus();
    await page.keyboard.press("Enter");
    return page.getByRole("dialog", { name: "Terminal sets" });
  };
  const sets = await openSets();
  await sets.getByLabel("Set name").fill("Trio");
  await sets.getByRole("button", { name: "Save current tabs as set" }).click();
  await expect(sets.getByRole("status").filter({ hasText: "Saved set Trio" })).toBeVisible();
  await expect(sets.getByText("4 terminals")).toBeVisible();
  await sets.getByRole("button", { name: "Done" }).click();

  // Close the tabs; the set stays.
  await page.keyboard.press("Escape");
  for (let i = 0; i < 3 && (await tabs.count()) > 0; i++) {
    const before = await tabs.count();
    await page.getByRole("button", { name: "Close Claude Code" }).first().focus();
    await page.keyboard.press("Enter");
    const sure = page.getByRole("dialog").getByRole("button", { name: /^(Close|Stop|Yes)/ });
    if (await sure.first().isVisible()) await sure.first().press("Enter");
    await expect(tabs).toHaveCount(before - 1);
  }
  await expect(tabs).toHaveCount(0);

  // Open the set: the three tabs come back.
  const again = await openSets();
  await again.getByRole("button", { name: "Open set Trio" }).click();
  await expect(tabs).toHaveCount(3, { timeout: 15_000 });
});
