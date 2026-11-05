import { expect, test } from "./fixtures";

const openDocs = async (page: import("@playwright/test").Page) => {
  await page.getByRole("navigation", { name: "App" }).getByRole("button", { name: "Docs & SDLC" }).click();
  const bar = page.getByRole("navigation", { name: "Apps" });
  await expect(bar).toBeVisible();
  return bar;
};

const openSection = async (page: import("@playwright/test").Page, name: string) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name, exact: true }).click();
  return page.getByRole("region", { name, exact: true });
};

test("turning a workspace part off removes it from the activity bar", async ({ page, openApp }) => {
  await openApp();
  await expect((await openDocs(page)).getByRole("button", { name: "Agent kit" })).toBeVisible();
  const region = await openSection(page, "Appearance");
  const kit = region.getByRole("switch", { name: "Show Agent kit" });
  await kit.click();
  await expect(kit).toHaveAttribute("aria-checked", "false");
  await expect((await openDocs(page)).getByRole("button", { name: "Agent kit" })).toHaveCount(0);
  await (await openSection(page, "Appearance")).getByRole("switch", { name: "Show Agent kit" }).click();
  await expect((await openDocs(page)).getByRole("button", { name: "Agent kit" })).toBeVisible();
});

test("a part moves with Alt+Arrow and the activity bar follows", async ({ page, openApp }) => {
  await openApp();
  await openDocs(page);
  const region = await openSection(page, "Appearance");
  await region.locator('[data-switch="app-kit"]').getByRole("switch").focus();
  await page.keyboard.press("Alt+ArrowUp");
  await expect(region.getByRole("status")).toContainText("Agent kit moved to place 5 of 8");
  const labels = (bar: import("@playwright/test").Locator) => bar.getByRole("button").evaluateAll((els) => els.map((e) => e.getAttribute("aria-label")));
  const moved = await labels(await openDocs(page));
  expect(moved.indexOf("Agent kit")).toBe(4);
  const again = await openSection(page, "Appearance");
  await again.getByRole("button", { name: "Reset order and visibility" }).click();
  await expect(again.getByRole("status")).toContainText("Order and visibility reset");
  const reset = await labels(await openDocs(page));
  expect(reset.indexOf("Agent kit")).toBe(5);
});

test("a PATH entry added in settings shows in the effective list", async ({ page, openApp }) => {
  await openApp();
  const region = await openSection(page, "Agents");
  const list = region.getByRole("list", { name: "PATH" });
  await expect(list.getByText("/opt/missing/bin")).toBeVisible();
  await expect(list.getByText("Folder not found")).toBeVisible();
  await region.locator('[data-field="path-entry"]').fill("/home/me/tools");
  await region.locator('[data-field="path-place"]').selectOption("prepend");
  await region.getByRole("button", { name: "Add folder" }).click();
  await expect(list.getByText("/home/me/tools")).toBeVisible();
  await expect(region.getByRole("status").filter({ hasText: "Added /home/me/tools" })).toHaveCount(1);
  await region.getByRole("button", { name: "Remove /home/me/tools" }).click();
  await expect(list.getByText("/home/me/tools")).toHaveCount(0);
});

test("a PATH entry with the separator is refused", async ({ page, openApp }) => {
  await openApp();
  const region = await openSection(page, "Agents");
  await region.locator('[data-field="path-entry"]').fill("/a" + (process.platform === "win32" ? ";" : ":") + "/b");
  await region.getByRole("button", { name: "Add folder" }).click();
  await expect(region.getByRole("alert").filter({ hasText: "PATH separator" })).toBeVisible();
});
