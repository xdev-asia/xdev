import { expect, fitsWidth, test } from "./fixtures";

const openMcp = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: "MCP", exact: true }).click();
  const region = page.getByRole("region", { name: "MCP", exact: true });
  await expect(region).toBeVisible();
  return { nav, region };
};

test("a tool switch is stored and still on after leaving the page", async ({ page, openApp }) => {
  await openApp();
  const { nav, region } = await openMcp(page);
  const send = region.getByRole("switch", { name: /send_to_tab/ });
  await expect(send).not.toBeChecked();
  await expect(region.getByRole("switch", { name: /list_tabs/ })).toBeChecked();
  await send.check();
  await expect(send).toBeChecked();
  await expect(region.getByRole("status").filter({ hasText: "send_to_tab is on" })).toBeVisible();
  await nav.getByRole("button", { name: "General", exact: true }).click();
  await expect(page.getByRole("region", { name: "General", exact: true })).toBeVisible();
  await nav.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByRole("region", { name: "MCP", exact: true }).getByRole("switch", { name: /send_to_tab/ })).toBeChecked();
});

test("add to this repo previews the entry and writes only after confirming", async ({ page, openApp }) => {
  await openApp();
  const { region } = await openMcp(page);
  await region.getByRole("button", { name: "Preview" }).click();
  const preview = region.locator('[data-preview="mcp"]');
  await expect(preview).toContainText('"mcpServers"');
  await expect(preview).toContainText('"xdev"');
  await expect(preview).toContainText('"mcp"');
  // Cancel leaves nothing behind: previewing again still says the file is new.
  await preview.getByRole("button", { name: "Cancel" }).click();
  await expect(preview).toBeHidden();
  await region.getByRole("button", { name: "Preview" }).click();
  await expect(preview).toContainText("does not exist yet");
  await preview.getByRole("button", { name: "Add to .mcp.json" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Added xdev to .mcp.json." })).toBeVisible();
  // Now the file is there with exactly this entry.
  await region.getByRole("button", { name: "Preview" }).click();
  await expect(preview).toContainText("already has this entry");
});

test("each agent CLI has a command to copy", async ({ page, openApp }) => {
  await openApp();
  const { region } = await openMcp(page);
  for (const agent of ["Claude Code", "Codex", "Gemini CLI"]) {
    await expect(region.getByText("mcp add", { exact: false }).first()).toBeVisible();
    await expect(region.locator(".connect-lang", { hasText: agent })).toBeVisible();
  }
  await expect(region.getByText("claude mcp add --scope user xdev")).toBeVisible();
});

test("the page fits a 360px screen", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await page.getByRole("button", { name: "Settings" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "MCP", exact: true }).click();
  await expect(page.getByRole("region", { name: "MCP", exact: true }).getByRole("switch", { name: /list_tabs/ })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
