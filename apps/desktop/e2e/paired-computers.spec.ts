import type { Page } from "@playwright/test";
import { expect, fitsWidth, test } from "./fixtures";

// Paired computers in the browser mock (`src/mockPeers.ts`): settings, pairing, the Computers
// panel and a watch tab. No network.

type Hooks = {
  __peersPairRequest(name?: string): Promise<string>;
  __peersDrop(peerId: string): void;
  __peersRise(peerId: string): void;
};

const hook = <K extends keyof Hooks>(page: Page, name: K, ...args: Parameters<Hooks[K]>) =>
  page.evaluate<unknown, [string, unknown[]]>(
    ([n, a]) => (window as unknown as { xdevMock: Record<string, (...x: unknown[]) => unknown> }).xdevMock[n](...a),
    [name as string, args as unknown[]],
  );

async function openPeersSettings(page: Page) {
  const later = page.getByRole("button", { name: "Maybe later" });
  if (await later.isVisible()) await later.click();
  await page.getByRole("button", { name: "Settings" }).click();
  const sidebar = page.getByRole("button", { name: "Show or hide the sidebar" });
  if ((await sidebar.count()) && (await sidebar.getAttribute("aria-expanded")) === "true") await sidebar.click();
  await page.getByRole("navigation", { name: "Settings sections" }).getByRole("button", { name: "Paired computers", exact: true }).click();
  const enable = page.getByRole("switch", { name: "Let paired computers connect" });
  if (!(await enable.isChecked())) await enable.check();
  await page.getByRole("button", { name: "Pair a computer" }).click();
  return page.getByRole("dialog", { name: "Pair a computer" });
}

test("joining a computer from the pair dialog ends with it in the list", async ({ page, openApp }) => {
  await openApp();
  const dialog = await openPeersSettings(page);
  await dialog.getByRole("tab", { name: "Join" }).click();
  await dialog.getByRole("listitem").filter({ hasText: "build-box" }).click();
  await dialog.getByRole("textbox", { name: "Code from the other computer" }).fill("7K4QM2XD9P");
  await dialog.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(dialog.getByTestId("peers-sas")).toContainText("482 913");
  await dialog.getByRole("button", { name: "They match, pair" }).click();
  await expect(dialog.getByText("Paired with build-box")).toBeVisible();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("peer-row").filter({ hasText: "build-box" })).toBeVisible();
});

test("a computer that joins this one's code asks here, and Viewer is the start", async ({ page, openApp }) => {
  await openApp();
  const dialog = await openPeersSettings(page);
  await expect(dialog.getByText("Expires in")).toBeVisible();
  await hook(page, "__peersPairRequest", "dev-laptop");
  const ask = page.getByRole("dialog", { name: "dev-laptop wants to pair" });
  await expect(ask.getByTestId("peers-sas")).toContainText("271 604");
  await expect(ask.getByRole("combobox", { name: "Role for dev-laptop" })).toHaveValue("viewer");
  await ask.getByRole("button", { name: "They match, pair" }).click();
  await expect(ask).toBeHidden();
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(page.getByTestId("peer-row").filter({ hasText: "dev-laptop" })).toBeVisible();
});

test("watching a paired computer's terminal, typing with control, and a dropped link coming back", async ({ page, openApp }) => {
  await openApp();
  await page.getByRole("button", { name: "Computers online: 1" }).click();
  await page.getByRole("button", { name: /^studio-mac/ }).click();
  await page.getByRole("button", { name: "Watch review" }).click();

  const tab = page.locator('.ws-tab[data-selected="true"]');
  await expect(tab).toContainText("review on studio-mac");
  await expect(page.getByText("Watching. You can't type here.")).toBeVisible();
  await expect(page.locator(".xterm:visible")).toHaveCount(1);
  // The terminal paints to a canvas, so what reaches the other computer is counted at the mock: each
  // write it takes from this computer is one `typed` activity.
  await page.evaluate(() => {
    const w = window as unknown as { __typed: number; xdevMock: { onPeerActivity(cb: (e: { action: string }) => void): Promise<() => void> } };
    w.__typed = 0;
    void w.xdevMock.onPeerActivity((e) => {
      if (e.action === "typed") w.__typed += 1;
    });
  });
  const sent = () => page.evaluate(() => (window as unknown as { __typed: number }).__typed);

  await page.locator(".xterm:visible").click();
  await page.keyboard.type("no");
  expect(await sent()).toBe(0);
  await page.getByRole("button", { name: "Take control" }).click();
  await expect(page.getByText("You are typing in review on studio-mac.")).toBeVisible();
  await page.locator(".xterm:visible").click();
  await page.keyboard.type("ls");
  await expect.poll(sent).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Stop typing" }).click();
  await expect(page.getByText("Watching. You can't type here.")).toBeVisible();

  await hook(page, "__peersDrop", "studio-mac");
  await expect(page.getByText("Disconnected from studio-mac. Reconnecting…")).toBeVisible();
  await hook(page, "__peersRise", "studio-mac");
  await expect(page.getByText("Disconnected from studio-mac. Reconnecting…")).toBeHidden({ timeout: 10_000 });
});

test("the pair dialog and the Computers panel fit at 360px", async ({ page, openApp, problems }) => {
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();
  const dialog = await openPeersSettings(page);
  await expect(dialog.getByText("Expires in")).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  const box = await dialog.boundingBox();
  expect(box && box.x >= 0 && box.x + box.width <= 360).toBe(true);
  await dialog.getByRole("tab", { name: "Join" }).click();
  expect(await fitsWidth(page)).toBe(true);
  await dialog.getByRole("button", { name: "Close" }).click();

  await page.getByRole("button", { name: "Computers online: 1" }).click();
  await expect(page.getByRole("button", { name: /^studio-mac/ })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  await page.getByRole("button", { name: /^studio-mac/ }).click();
  await expect(page.getByRole("button", { name: "Watch review" })).toBeVisible();
  expect(await fitsWidth(page)).toBe(true);
  expect(problems).toEqual([]);
});
