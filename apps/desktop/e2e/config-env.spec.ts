import { expect, fitsWidth, test } from "./fixtures";

const openSection = async (page: import("@playwright/test").Page, name: string) => {
  await page.getByRole("button", { name: "Settings" }).click();
  // The skill tip floats over the page's lower right; dismiss it so it cannot cover a click.
  const later = page.getByRole("button", { name: "Maybe later" });
  if (await later.isVisible()) await later.click();
  const nav = page.getByRole("navigation", { name: "Settings sections" });
  await expect(nav).toBeVisible();
  // At a narrow width the workspace sidebar covers the settings nav until it is hidden.
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.count()) > 0 && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await nav.getByRole("button", { name, exact: true }).click();
  const region = page.getByRole("region", { name, exact: true });
  await expect(region).toBeVisible();
  return region;
};

test("a repo's environment rows save and the preview masks the secret", async ({ page, openApp }) => {
  await openApp();
  const region = await openSection(page, "Repos");
  const env = region.getByRole("group", { name: "Environment", exact: true }).first();
  await env.scrollIntoViewIfNeeded();
  await env.getByRole("button", { name: "Add variable" }).click();

  const key = env.getByRole("textbox", { name: "Name" }).first();
  await key.fill("1bad");
  await expect(env.getByText("Use letters, digits and underscores, not starting with a digit.")).toBeVisible();
  await expect(env.getByRole("button", { name: "Save environment" })).toBeDisabled();
  await key.fill("API_TOKEN");
  await env.getByLabel("Secret").first().check();
  await env.getByLabel("Value").first().fill("hunter2");
  await env.getByRole("button", { name: "Save environment" }).click();

  await expect(env.getByRole("status")).toHaveText("Environment saved.");
  const preview = env.getByRole("group", { name: "Effective environment" });
  await expect(preview).toContainText("API_TOKEN=••••••••");
  await expect(preview).not.toContainText("hunter2");
  // The stored secret is not echoed back into the form.
  await expect(env.getByLabel("Value").first()).toHaveValue("");
});

test("settings export saves a file and import previews it", async ({ page, openApp }) => {
  await openApp();
  const region = await openSection(page, "Advanced");
  await region.getByRole("button", { name: "Export settings" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Saved" })).toContainText("export-1.json");

  await region.getByRole("button", { name: "Import settings" }).click();
  const preview = region.getByRole("region", { name: "Import from xdev-settings.json" });
  await expect(preview).toBeVisible();
  await expect(preview).toContainText("proxyUrl");
  await expect(preview).toContainText("Ignored keys: futureField");
  await expect(preview).toContainText("Ignored sections: mystery");
  await expect(preview).toContainText("Secrets ignored: 1");
  await expect(preview).not.toContainText("do-not-import");
  await preview.getByRole("button", { name: "Apply selected" }).click();
  await expect(region.getByRole("status").filter({ hasText: "Applied" })).toContainText("Applied 1 sections.");
  await expect(region.getByRole("textbox", { name: /^Proxy URL/ })).toHaveValue("http://127.0.0.1:8080");
});

test("the environment and the import preview fit at 360px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  const repos = await openSection(page, "Repos");
  await repos.getByRole("group", { name: "Environment", exact: true }).first().getByRole("button", { name: "Add variable" }).click();
  expect(await fitsWidth(page)).toBe(true);
  const advanced = await openSection(page, "Advanced");
  await advanced.getByRole("button", { name: "Import settings" }).click();
  await expect(advanced.getByRole("region", { name: "Import from xdev-settings.json" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
