import type { Locator, Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

/** Opens team charts from the command palette. */
async function openCharts(page: Page): Promise<Locator> {
  await expect(page.getByRole("main", { name: "Terminals" })).toBeVisible();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await expect(palette).toBeVisible();
  await palette.getByRole("textbox").fill("Open team charts");
  await palette.getByRole("option", { name: "Open team charts" }).click();
  const charts = page.getByRole("dialog", { name: "Team charts" });
  await expect(charts).toBeVisible();
  return charts;
}

/** Builds a 3-seat hierarchy (Lead, Builder, Tester) in the editor and saves it. */
async function buildCrew(page: Page): Promise<Locator> {
  let charts = await openCharts(page);
  await expect(charts).toContainText("No team charts yet");
  await charts.getByRole("button", { name: "New chart" }).click();
  const editor = page.getByRole("dialog", { name: "New team chart" });
  await editor.getByRole("textbox", { name: "Name" }).fill("Review crew");
  await editor.getByRole("textbox", { name: "Role of seat 1" }).fill("Lead");
  await editor.getByRole("button", { name: "Add seat" }).click();
  await editor.getByRole("textbox", { name: "Role of seat 2" }).fill("Tester");
  await editor.getByRole("button", { name: "Add seat" }).click();
  await editor.getByRole("textbox", { name: "Role of seat 3" }).fill("Builder");
  // Builder goes above Tester, from the keyboard.
  await editor.getByRole("button", { name: "Move Builder up" }).focus();
  await page.keyboard.press("Enter");
  await expect(editor.getByRole("status").filter({ hasText: "Moved" })).toHaveText("Moved Builder to position 2.");
  await expect(editor.getByRole("listitem").nth(1)).toHaveAccessibleName("Builder");
  await expect(editor.getByRole("combobox", { name: "Lead", exact: true })).toHaveValue("seat-1");
  await expect(editor.getByTestId("chart-preview").locator(".charts-node")).toHaveCount(3);
  await editor.getByRole("button", { name: "Save chart" }).click();
  charts = page.getByRole("dialog", { name: "Team charts" });
  await expect(charts.getByRole("status")).toHaveText("Saved Review crew.");
  await expect(charts.getByRole("listitem").filter({ hasText: "Review crew" })).toContainText("Hierarchy · 3 seats");
  return charts;
}

test("build a 3-seat hierarchy chart, save it and run it as 3 tabs", async ({ page, openApp }) => {
  await openApp();
  const charts = await buildCrew(page);
  await charts.getByRole("button", { name: "Run Review crew" }).click();
  await expect(charts).toBeHidden();
  await expect(page.getByText("Started Review crew in 3 tabs.")).toBeVisible();
  for (const name of ["Lead", "Builder", "Tester"]) await expect(page.getByRole("tab", { name: new RegExp(`^${name}`) })).toBeVisible();
});

test("a kind switch keeps the seats and a router asks for a match table entry", async ({ page, openApp }) => {
  await openApp();
  const charts = await buildCrew(page);
  await charts.getByRole("button", { name: "Edit Review crew" }).click();
  const editor = page.getByRole("dialog", { name: "Edit team chart" });
  await editor.getByRole("button", { name: "Router" }).click();
  await expect(editor.getByRole("status").filter({ hasText: "Kind" })).toHaveText("Kind is now Router. The seats are kept.");
  await expect(editor.locator(".charts-seat")).toHaveCount(3);
  await expect(editor.getByText("Add a row to the match table.")).toBeVisible();
  await expect(editor.getByRole("button", { name: "Save chart" })).toBeDisabled();
  await editor.getByRole("button", { name: "Add route" }).click();
  await editor.getByRole("textbox", { name: "Work kind" }).fill("bug");
  await editor.getByRole("button", { name: "Save chart" }).click();
  await expect(page.getByRole("dialog", { name: "Team charts" }).getByRole("listitem").filter({ hasText: "Review crew" })).toContainText("Router · 3 seats");
});

test("Mission Control's team map saves as a chart", async ({ page, openApp }) => {
  await openApp();
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Show team map");
  await palette.getByRole("option", { name: "Show team map" }).click();
  const mission = page.getByRole("dialog", { name: "Mission Control" });
  await mission.getByRole("button", { name: "Save as chart" }).click();
  const editor = page.getByRole("dialog", { name: "New team chart" });
  await expect(editor.getByRole("textbox", { name: "Name" })).toHaveValue("Team from Mission Control");
  await expect(editor.locator(".charts-seat")).toHaveCount(4);
  await editor.getByRole("button", { name: "Save chart" }).click();
  await expect(page.getByRole("dialog", { name: "Team charts" })).toContainText("Hierarchy · 4 seats");
});

test("team charts fit at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  const charts = await openCharts(page);
  await charts.getByRole("button", { name: "New chart" }).click();
  const editor = page.getByRole("dialog", { name: "New team chart" });
  await editor.getByRole("button", { name: "Add seat" }).click();
  await expect(editor.locator(".charts-seat")).toHaveCount(2);
  expect(await fitsWidth(page)).toBe(true);
  const box = await editor.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  for (const b of await editor.getByRole("button").all()) {
    const r = await b.boundingBox();
    if (r) expect(Math.min(r.width, r.height)).toBeGreaterThanOrEqual(24);
  }
});
