import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

type Mock = {
  __captureTrigger(): void;
  __captureSaved(): { path: string; bytes: Uint8Array } | null;
  __captureSeed(): string;
  __clipboardImage(path: string | null): void;
  __ptyWritten(id: string): string;
};

/** The first-run tip card sits over the bottom-right corner. */
async function dismissTip(page: Page): Promise<void> {
  const later = page.getByRole("complementary", { name: "Tip: xDev skill" }).getByRole("button", { name: "Maybe later" });
  if (await later.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await later.click();
}

/** Starts a Claude tab and returns its tab id. */
async function startAgent(page: Page): Promise<string> {
  await dismissTip(page);
  await page.getByRole("button", { name: "Claude Code", exact: true }).click();
  await page.getByRole("button", { name: "Allow and start" }).click();
  const tab = page.locator('.ws-tab[data-selected="true"]');
  await expect(tab).toBeVisible();
  return (await tab.getAttribute("data-tab-id"))!;
}

const trigger = (page: Page) => page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__captureTrigger());
const saved = (page: Page) => page.evaluate(() => (window as unknown as { xdevMock: Mock }).xdevMock.__captureSaved()?.bytes.length ?? 0);
const written = (page: Page, id: string) => page.evaluate((tab) => (window as unknown as { xdevMock: Mock }).xdevMock.__ptyWritten(tab), id);

/** Drags on the canvas between two fractions of its size. */
async function drag(page: Page, from: [number, number], to: [number, number]): Promise<void> {
  const box = (await page.getByRole("img", { name: "Screenshot to annotate" }).boundingBox())!;
  await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * ((from[0] + to[0]) / 2), box.y + box.height * ((from[1] + to[1]) / 2));
  await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1]);
  await page.mouse.up();
}

test("annotate a capture, undo and redo, and send the PNG path to the agent tab", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp();
  const id = await startAgent(page);

  await trigger(page);
  const dialog = page.getByRole("dialog", { name: "Annotate screenshot" });
  await expect(dialog).toBeVisible();

  await dialog.getByRole("button", { name: "Box", exact: true }).click();
  await drag(page, [0.1, 0.1], [0.4, 0.4]);
  await dialog.getByRole("button", { name: "Blur", exact: true }).click();
  await drag(page, [0.5, 0.5], [0.8, 0.7]);
  await dialog.getByRole("button", { name: "Text", exact: true }).click();
  const canvas = (await page.getByRole("img", { name: "Screenshot to annotate" }).boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width * 0.2, canvas.y + canvas.height * 0.8);
  await page.getByRole("textbox", { name: "Type a note" }).fill("here");
  await page.keyboard.press("Enter");

  const undo = dialog.getByRole("button", { name: "Undo" });
  const redo = dialog.getByRole("button", { name: "Redo" });
  await expect(redo).toBeDisabled();
  await undo.click();
  await expect(redo).toBeEnabled();
  await redo.click();
  await expect(redo).toBeDisabled();

  await dialog.getByRole("button", { name: "Send to agent" }).click();
  await expect(dialog).toBeHidden();
  await expect.poll(() => saved(page)).toBeGreaterThan(0);
  await expect.poll(() => written(page, id)).toContain(".png");
  await expect(page.getByText(/Screenshot sent to/)).toBeVisible();
});

test("with no agent tab, Send says to open one", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp();
  await dismissTip(page);
  await trigger(page);
  const dialog = page.getByRole("dialog", { name: "Annotate screenshot" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Send to agent" }).click();
  await expect(page.getByText("Open an agent tab to send the screenshot to.")).toBeVisible();
  await expect(dialog).toBeVisible();
});

test("the palette annotates the clipboard image, and the dialog fits 360 px", async ({ page, openApp }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp();
  await dismissTip(page);
  await page.evaluate(() => {
    const m = (window as unknown as { xdevMock: Mock }).xdevMock;
    m.__clipboardImage(m.__captureSeed());
  });
  const mac = await page.evaluate(() => /Mac|iPhone|iPad/.test(navigator.userAgent));
  await page.keyboard.press(mac ? "Meta+j" : "Control+j");
  const palette = page.getByRole("dialog", { name: "Jump to…" });
  await palette.getByRole("textbox").fill("Annotate clipboard image");
  await palette.getByRole("option", { name: "Annotate clipboard image" }).click();
  const dialog = page.getByRole("dialog", { name: "Annotate screenshot" });
  await expect(dialog).toBeVisible();

  await page.setViewportSize({ width: 360, height: 740 });
  await expect(dialog.getByRole("button", { name: "Send to agent" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
});
