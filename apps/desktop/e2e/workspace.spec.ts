import { expect, test } from "./fixtures";

test("command palette opens with its shortcut and runs a command", async ({ page, openApp }) => {
  await openApp();
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(page.getByRole("tree", { name: "Files of this worktree" })).toBeVisible();
  // The app picks its modifier from the page's platform, which is not always the host's.
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("settings");
  await palette.getByRole("option").first().click();
  await expect(palette).toBeHidden();
  await expect(page.getByRole("navigation", { name: "Settings sections" })).toBeVisible();
});

test("create worktree dialog opens and its sources switch", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "New worktree" }).click();
  const dialog = page.getByRole("dialog", { name: "New worktree" });
  await expect(dialog).toBeVisible();
  const source = dialog.getByRole("group", { name: "Create from" });
  await expect(source.getByRole("button", { name: "New name" })).toHaveAttribute("aria-pressed", "true");
  await source.getByRole("button", { name: "GitHub" }).click();
  await expect(source.getByRole("button", { name: "GitHub" })).toHaveAttribute("aria-pressed", "true");
  await expect(source.getByRole("button", { name: "New name" })).toHaveAttribute("aria-pressed", "false");
  await source.getByRole("button", { name: "Branch" }).click();
  await expect(source.getByRole("button", { name: "Branch" })).toHaveAttribute("aria-pressed", "true");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
});

test("a terminal tab opens and the new tab menu lists shells", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "PowerShell" }).click();
  await expect(page.getByRole("tab", { name: "PowerShell" })).toBeVisible();
  await expect(page.locator(".xterm")).toBeVisible();
  await page.getByRole("button", { name: "New tab" }).click();
  const shells = page.getByRole("group", { name: "Shells" });
  await expect(shells.getByRole("menuitem", { name: "PowerShell" })).toBeVisible();
  await expect(shells.getByRole("menuitem", { name: "CMD" })).toBeVisible();
  await expect(shells.getByRole("menuitem", { name: "WSL Ubuntu" })).toBeVisible();
});

test("a file opens from the tree and the editor shows its content", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("treeitem", { name: "README.md" }).dblclick();
  await expect(page.getByRole("tab", { name: "README.md" })).toBeVisible();
  const editor = page.getByRole("textbox", { name: "Document editor" });
  await expect(editor).toBeVisible();
  await expect(editor).not.toBeEmpty();
});

test("the sessions panel lists agent sessions", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Sessions" }).click();
  const panel = page.getByRole("region", { name: "Agent sessions" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Fix the parser test on Windows paths/ })).toBeVisible();
  await panel.getByRole("searchbox", { name: "Search sessions" }).fill("landing");
  await expect(panel.getByRole("button", { name: /^Update the landing page copy/ })).toBeVisible();
  await expect(panel.getByRole("button", { name: /^Fix the parser test/ })).toBeHidden();
});

test("the automations page renders its templates", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: "Automations" }).click();
  const page_ = page.getByRole("region", { name: "Automations" });
  await expect(page_.getByRole("searchbox", { name: "Search automations" })).toBeVisible();
  await expect(page_.getByRole("button", { name: "New automation" })).toBeVisible();
  await expect(page_.getByRole("list", { name: "Start with a template" })).toBeVisible();
});

test("docs: the Changes tab lists the seeded outside edit", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: "Docs & SDLC" }).click();
  await page.getByRole("button", { name: /^Changes, \d+ pending/ }).click();
  await expect(page.getByRole("heading", { name: "README.md", level: 1 })).toBeVisible();
  await expect(page.getByRole("main").getByText("Edited outside")).toBeVisible();
});

test("docs: the agent kit Skills tab renders", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: "Docs & SDLC" }).click();
  await page.getByRole("button", { name: "Agent kit" }).click();
  const kit = page.getByRole("region", { name: "Agent kit" });
  await expect(kit.getByRole("tab", { name: "Skills" })).toHaveAttribute("aria-selected", "true");
  await expect(kit.getByRole("table")).toBeVisible();
  await expect(kit.getByRole("row", { name: /release-notes/ })).toBeVisible();
});
