import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

const isMac = (page: Page) => page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
const mod = async (page: Page) => ((await isMac(page)) ? "Meta" : "Control");

async function quickOpen(page: Page, name: string) {
  await page.keyboard.press(`${await mod(page)}+p`);
  const dialog = page.getByRole("dialog", { name: "Go to file" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox").fill(name);
  await expect(dialog.getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name })).toBeVisible();
}

/** Types at the end of the file (insertText skips the auto-closing of brackets). */
async function append(page: Page, text: string) {
  await page.locator(".cm-content:visible").first().click();
  await page.keyboard.press(`${await mod(page)}+End`);
  await page.keyboard.insertText(text);
}

/** Moves the mouse onto `word` inside the editor line that has `lineText`. */
async function pointAt(page: Page, lineText: string, word: string, click = false) {
  const box = await page.locator(".cm-line:visible", { hasText: lineText }).first().evaluate(
    (line, w) => {
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const at = (n.textContent ?? "").indexOf(w);
        if (at < 0) continue;
        const range = document.createRange();
        range.setStart(n, at);
        range.setEnd(n, at + w.length);
        const r = range.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      }
      return null;
    },
    word,
  );
  expect(box, `"${word}" in the line`).not.toBeNull();
  if (click) await page.mouse.click(box!.x, box!.y);
  else await page.mouse.move(box!.x, box!.y);
}

async function startServers(page: Page) {
  const panel = page.getByRole("region", { name: "Language servers" });
  await expect(panel).toContainText("Start language servers for this repo?");
  await panel.getByRole("button", { name: "Start" }).click();
  await expect(panel).toBeHidden();
}

/** Opens session.ts, starts the servers, and gives the file a declaration and a TODO line. */
async function prepare(page: Page, openApp: () => Promise<void>) {
  await openApp();
  await quickOpen(page, "session.ts");
  await startServers(page);
  await append(page, "\nexport function greet() {}\n// TODO later\n");
  await expect(page.locator(".cm-lintRange-warning:visible")).toBeVisible();
}

test("the trust panel asks once, Start brings the servers up, and a TODO line gets a warning underline", async ({ page, openApp }) => {
  await openApp();
  await quickOpen(page, "session.ts");
  const panel = page.getByRole("region", { name: "Language servers" });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("button", { name: "Not now" })).toBeVisible();
  await panel.getByRole("button", { name: "Start" }).click();
  await expect(panel).toBeHidden();
  await append(page, "\n// TODO later\n");
  await expect(page.locator(".cm-lintRange-warning:visible")).toBeVisible();
});

test("hovering a name shows its declaration", async ({ page, openApp }) => {
  await prepare(page, openApp);
  await pointAt(page, "export function greet", "greet");
  const tip = page.locator(".cm-tooltip .lsp-hover");
  await expect(tip).toContainText("export function greet() {}");
});

test("F12 opens the file that declares the name at its line", async ({ page, openApp }) => {
  await prepare(page, openApp);
  await quickOpen(page, "format.ts");
  // The underline shows that the server has the new text.
  await append(page, "\ngreet();\n// TODO use it\n");
  await expect(page.locator(".cm-lintRange-warning:visible")).toBeVisible();
  await pointAt(page, "greet();", "greet", true);
  await page.keyboard.press("F12");
  await expect(page.getByRole("tab", { name: "session.ts" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".cm-content:visible").first()).toContainText("export function greet() {}");
});

test("F2 renames a name in every open file and leaves them unsaved", async ({ page, openApp }) => {
  await prepare(page, openApp);
  await quickOpen(page, "format.ts");
  await append(page, "\ngreet();\n// TODO use it\n");
  await expect(page.locator(".cm-lintRange-warning:visible")).toBeVisible();
  // Saved, so the dots after the rename come from the rename alone.
  await page.keyboard.press(`${await mod(page)}+s`);
  await page.getByRole("tab", { name: "session.ts" }).click();
  await page.keyboard.press(`${await mod(page)}+s`);
  await expect(page.locator(".ws-tab-dirty")).toHaveCount(0);
  await pointAt(page, "export function greet", "greet", true);
  await page.keyboard.press("F2");
  const dialog = page.getByRole("dialog", { name: "Rename symbol" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("textbox", { name: "New name" }).fill("hello");
  await dialog.getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Renamed in 2 files. Review and save them.")).toBeVisible();
  await expect(page.locator(".ws-tab-dirty")).toHaveCount(2);
  await expect(page.locator(".cm-content:visible").first()).toContainText("export function hello() {}");
});

test("Go to symbol in workspace finds a declaration and opens it", async ({ page, openApp }) => {
  await prepare(page, openApp);
  await quickOpen(page, "format.ts");
  const m = await mod(page);
  await page.keyboard.press(`${m}+j`);
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Go to symbol in workspace");
  await palette.getByRole("option", { name: "Go to symbol in workspace" }).click();
  const dialog = page.getByRole("dialog", { name: "Go to symbol" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox", { name: "Symbol name" }).fill("zzzz");
  await expect(dialog.getByRole("status")).toHaveText("No symbols match.");
  await dialog.getByRole("combobox", { name: "Symbol name" }).fill("gree");
  await expect(dialog.getByRole("option", { name: /greet/ })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("tab", { name: "session.ts" })).toHaveAttribute("aria-selected", "true");
});

test("the trust panel fits a 360px screen", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();
  await quickOpen(page, "session.ts");
  const panel = page.getByRole("region", { name: "Language servers" });
  await expect(panel).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  const buttons = await panel.getByRole("button").evaluateAll((els) => els.map((e) => e.getBoundingClientRect().height));
  for (const h of buttons) expect(h).toBeGreaterThanOrEqual(24);
});
