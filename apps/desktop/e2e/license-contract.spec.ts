import { expect, fitsWidth, test } from "./fixtures";

// The license contract in the browser mock (`src/mockLicense.ts`), which the license UI lanes build on.
// This checks the shapes `window.xdevMock` returns. No network.

type Mock = {
  licenseState(): Promise<unknown>;
  licenseBuy(product: string): Promise<void>;
  licenseActivate(grant?: string): Promise<unknown>;
  __licenseCheckoutComplete(): void;
};

test("buying Pro resolves after checkout and the state turns Pro at 360px", async ({ page, openApp }) => {
  await page.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)[:/])/, (route) => route.abort());
  await page.setViewportSize({ width: 360, height: 740 });
  await openApp();

  const got = await page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const before = await mock.licenseState();
    let resolved = false;
    const buying = mock.licenseBuy("pro").then(() => {
      resolved = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    const early = resolved;
    mock.__licenseCheckoutComplete();
    await buying;
    const after = await mock.licenseState();
    return { before, early, resolved, after };
  });

  expect(got.before).toEqual({ state: "free", notice: null });
  expect(got.early).toBe(false);
  expect(got.resolved).toBe(true);
  expect(got.after).toMatchObject({ state: "active", plan: ["pro"], freshness: { kind: "fresh" } });
  expect(await fitsWidth(page)).toBe(true);
});

test("with no free seat, activate rejects license_no_seat", async ({ page, openApp }) => {
  await page.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)[:/])/, (route) => route.abort());
  await openApp("?license=noseat");

  const got = await page.evaluate(async () => {
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const state = await mock.licenseState();
    const error = await mock.licenseActivate().catch((e: unknown) => e);
    return { state, error };
  });

  expect(got.state).toEqual({ state: "free", notice: "license_no_seat" });
  expect(got.error).toEqual({ code: "license_no_seat" });
});
