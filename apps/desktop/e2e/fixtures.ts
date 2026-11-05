import { expect, test as base, type Page } from "@playwright/test";

/** localStorage key of the first-run wizard's outcome (src/onboarding/onboardingState.ts). */
const ONBOARDING_KEY = "xdev.onboarding.v1";

type Fixtures = {
  /** Fails the test on any uncaught page error or console error. */
  problems: string[];
  /** Opens the app with the first-run wizard already finished. */
  openApp: (query?: string) => Promise<void>;
};

export const test = base.extend<Fixtures>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      page.on("console", (m) => {
        if (m.type() === "error") problems.push(`console: ${m.text()}`);
      });
      await use(problems);
      expect(problems, "uncaught page errors and console errors").toEqual([]);
    },
    { auto: true },
  ],
  openApp: async ({ page }, use) => {
    await use(async (query = "") => {
      await page.addInitScript(
        ([key]) => window.localStorage.setItem(key, JSON.stringify({ status: "done", answers: {} })),
        [ONBOARDING_KEY],
      );
      await page.goto(`/${query}`);
      await expect(page.getByRole("button", { name: "Settings" })).toBeVisible();
    });
  },
});

export { expect };

/** True when the page has no horizontal scroll. */
export async function fitsWidth(page: Page): Promise<boolean> {
  return page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
}
