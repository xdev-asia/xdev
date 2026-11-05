import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

const openOrchestration = async (page: Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  // In a narrow window the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((page.viewportSize()?.width ?? 1280) < 600 && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Orchestration", exact: true }).click();
  const failover = page.getByRole("region", { name: "Failover", exact: true });
  await expect(failover).toBeVisible();
  return failover;
};

test("with failover on and a backup agent, a failing worker's replacement says it failed over", async ({ page, openApp }) => {
  await openApp();
  const failover = await openOrchestration(page);
  await failover.getByRole("switch", { name: "Fail over workers that fail" }).check();
  await expect(failover.getByRole("status")).toHaveText("Saved.");
  await failover.getByRole("combobox", { name: "Backup agent" }).selectOption({ label: "Codex" });
  await failover.getByRole("button", { name: "Add backup agent" }).click();
  await expect(failover.getByRole("status")).toHaveText("Codex added at position 1.");
  await expect(failover.getByRole("list")).toContainText("Codex");
  await expect(failover.getByText("You must follow each provider's terms when switching accounts.")).toBeVisible();

  await page.getByRole("button", { name: "Workspace" }).click();
  // The mock plays the backend: worker w1 (Claude Code) exited with an error, and Codex takes its task.
  const tab = await page.evaluate(async () => {
    type Mock = { __orchFailWorker(from: Record<string, unknown>, reason?: string): Promise<string | null> };
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    return mock.__orchFailWorker({
      dispatch: "disp_e2e",
      tab: "w1",
      title: "worker-fix-parser",
      worktree: "/demo/xdev",
      profile: "claude",
      prompt: "Fix the parser test.",
      setup: "skip",
      readyTimeoutMs: 30_000,
    });
  });
  expect(tab).toBe("w1-f1");
  await expect(page.getByText("Claude Code failed (exited with an error). Codex took over the task.")).toBeVisible();
  // The backup is the first agent this worktree runs, so the trust prompt comes first.
  const allow = page.getByRole("button", { name: "Allow and start" });
  await allow.click();
  await expect(allow).toBeHidden();
  await expect(page.getByRole("tab", { name: /worker-fix-parser/ })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("status").filter({ hasText: "Failed over from Claude Code (exited with an error)" })).toBeVisible();
});

test("the backup agent list reorders by keyboard and fits a 360px window", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();
  const failover = await openOrchestration(page);
  const add = failover.getByRole("button", { name: "Add backup agent" });
  const pick = failover.getByRole("combobox", { name: "Backup agent" });
  await pick.selectOption({ label: "Codex" });
  await add.click();
  await expect(failover.getByRole("status")).toHaveText("Codex added at position 1.");
  await pick.selectOption({ label: "Aider" });
  await add.click();
  await expect(failover.getByRole("status")).toHaveText("Aider added at position 2.");
  const up = failover.getByRole("button", { name: "Move Aider up" });
  await up.focus();
  await page.keyboard.press("Enter");
  await expect(failover.getByRole("status")).toHaveText("Aider moved to position 1.");
  await expect(failover.getByRole("button", { name: "Move Aider down" })).toBeFocused();
  await expect(failover.getByRole("listitem")).toHaveText(["Aider", "Codex"]);
  expect(await fitsWidth(page)).toBe(true);
});
