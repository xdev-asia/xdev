import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

const openAccount = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  // In a narrow window the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((page.viewportSize()?.width ?? 1280) < 600 && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await nav.getByRole("button", { name: "xDev ID", exact: true }).click();
  const region = page.getByRole("region", { name: "xDev ID", exact: true });
  await expect(region).toBeVisible();
  return region.getByRole("region", { name: "Claude Code", exact: true });
};

/** The accounts the saved session data holds for the worktree's agent tabs, in tab order. */
const tabAccounts = (page: Page) =>
  page.evaluate(async () => {
    type Snap = { worktrees: Record<string, { tabs: Record<string, { agent?: boolean; account: string | null }> }> };
    const snap = (await (window as unknown as { xdevMock: { layoutLoad(): Promise<Snap | null> } }).xdevMock.layoutLoad()) ?? { worktrees: {} };
    return Object.values(snap.worktrees).flatMap((w) => Object.values(w.tabs).filter((t) => t.agent).map((t) => t.account));
  });

const startClaude = async (page: Page, first: boolean) => {
  if (first) await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  else {
    await page.getByRole("button", { name: "New tab" }).click();
    const item = page.getByRole("group", { name: "Agents" }).getByRole("menuitem", { name: "Claude Code" });
    await item.focus();
    await page.keyboard.press("Enter");
  }
  if (first) {
    const allow = page.getByRole("button", { name: "Allow and start" });
    await allow.click();
    await expect(allow).toBeHidden();
  }
};

test("the routing policy persists, and two tabs of one provider run on different accounts", async ({ page, openApp }) => {
  await openApp();
  let claude = await openAccount(page);
  const policy = claude.getByRole("combobox", { name: "New tabs start on" });
  await policy.selectOption({ label: "Most quota left" });
  await expect(claude.getByRole("status")).toHaveText("Saved.");
  // The preview keeps its backend in memory, so check across leaving and reopening Settings.
  await page.getByRole("button", { name: "Workspace" }).click();
  claude = await openAccount(page);
  await expect(claude.getByRole("combobox", { name: "New tabs start on" })).toHaveValue("most_quota");

  // Round robin hands consecutive new tabs to different accounts; each tab keeps its own.
  await claude.getByRole("combobox", { name: "New tabs start on" }).selectOption({ label: "Round robin" });
  await expect(claude.getByRole("status")).toHaveText("Saved.");
  await page.getByRole("button", { name: "Workspace" }).click();
  await startClaude(page, true);
  await expect.poll(() => tabAccounts(page), { timeout: 5_000 }).toHaveLength(1);
  await startClaude(page, false);
  await expect.poll(() => tabAccounts(page), { timeout: 5_000 }).toHaveLength(2);
  const [a, b] = await tabAccounts(page);
  expect(a).toBeTruthy();
  expect(b).toBeTruthy();
  expect(a).not.toBe(b);
});

test("the routing settings fit a 360px window and the priority list moves by keyboard", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();
  const claude = await openAccount(page);
  await claude.getByRole("combobox", { name: "New tabs start on" }).selectOption({ label: "Priority order" });
  const down = claude.getByRole("button", { name: "Move claude-2 down" });
  await down.focus();
  await page.keyboard.press("Enter");
  await expect(claude.getByRole("status")).toHaveText("claude-2 moved to position 2.");
  await expect(claude.getByRole("button", { name: "Move claude-2 down" })).toBeFocused();
  await expect(claude.getByText("When an account reaches 95%, start new agents on another account")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
