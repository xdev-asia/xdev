import { expect, fitsWidth, test } from "./fixtures";

const NAME = "Screenshots";
const ANNOTATE = "Annotate pasted images before sending";

type Mock = { __captureFail(code: string): void };

const openScreenshots = async (page: import("@playwright/test").Page) => {
  await page.getByRole("button", { name: "Settings" }).click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  await nav.getByRole("button", { name: NAME, exact: true }).click();
  const region = page.getByRole("region", { name: NAME, exact: true });
  await expect(region).toBeVisible();
  return region;
};

test("annotate pasted images stays on after a reload", async ({ page, openApp }) => {
  await openApp("?capturekeep");
  let region = await openScreenshots(page);
  const annotate = region.getByRole("switch", { name: ANNOTATE });
  await expect(annotate).not.toBeChecked();
  await annotate.click();
  await expect(annotate).toBeChecked();

  await page.reload();
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
  region = await openScreenshots(page);
  await expect(region.getByRole("switch", { name: ANNOTATE })).toBeChecked();
});

test("on Wayland a banner offers the command to bind", async ({ page, context, openApp }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openApp("?capture=wayland");
  const region = await openScreenshots(page);
  await expect(region.getByText("Global shortcuts are not available on Wayland")).toBeVisible();
  await region.getByRole("button", { name: "Copy command" }).click();
  await expect(region.getByText("Command copied.")).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("xdev capture");
});

test("the page fits a 360px screen", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp("?capture=wayland");
  await page.getByRole("button", { name: "Settings" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: NAME, exact: true }).click();
  await expect(page.getByRole("region", { name: NAME, exact: true }).getByRole("switch", { name: ANNOTATE })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});

test("a failed capture shows a toast", async ({ page, openApp }) => {
  await openApp();
  await page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__captureFail("capture_no_tool"));
  await expect(page.getByText("No screenshot tool was found. Install grim and slurp, spectacle, gnome-screenshot, maim or scrot.")).toBeVisible();
});
