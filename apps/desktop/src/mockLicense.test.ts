import type { LicenseState } from "@xdev/bindings";
import { afterEach, expect, test, vi } from "vitest";
import { createMockLicense, licenseModeFrom, MOCK_DEVICE_ID } from "./mockLicense";

afterEach(() => vi.unstubAllGlobals());

test("the query string picks the mode; anything else is free", () => {
  expect(licenseModeFrom("")).toBe("free");
  expect(licenseModeFrom("?license=pro")).toBe("pro");
  expect(licenseModeFrom("?repo=1&license=grace")).toBe("grace");
  expect(licenseModeFrom("?license=expired")).toBe("expired");
  expect(licenseModeFrom("?license=noseat")).toBe("noseat");
  expect(licenseModeFrom("?license=team")).toBe("free");
});

test("the default mode comes from location.search", async () => {
  vi.stubGlobal("location", { search: "?license=grace" });
  const s = await createMockLicense().licenseState();
  expect(s).toMatchObject({ state: "active", freshness: { kind: "grace", daysOffline: 9 } });
});

test("free: no plan, and every feature is denied", async () => {
  const l = createMockLicense("free");
  expect(await l.licenseState()).toEqual({ state: "free", notice: null });
  expect(await l.licenseAllows("pro.phone")).toBe(false);
  await expect(l.licenseActivate()).rejects.toEqual({ code: "license_unavailable" });
});

test("pro: fresh, with the Pro features and a seat", async () => {
  const l = createMockLicense("pro");
  const s = await l.licenseState();
  expect(s).toMatchObject({ state: "active", plan: ["pro"], freshness: { kind: "fresh" }, device: { max: 2, active: 1 } });
  expect(await l.licenseAllows("pro.phone")).toBe(true);
  expect(await l.licenseAllows("pro.early")).toBe(true);
  expect(await l.licenseAllows("sync.vault")).toBe(false);
  const devices = await l.licenseDevices();
  expect(devices.find((d) => d.id === MOCK_DEVICE_ID)?.proGrant).toBe("grant-pro-1");
});

test("expired: still active, marked expired", async () => {
  const s = await createMockLicense("expired").licenseState();
  expect(s).toMatchObject({ state: "active", freshness: { kind: "expired" } });
});

test("noseat: activate rejects license_no_seat", async () => {
  const l = createMockLicense("noseat");
  expect(await l.licenseState()).toEqual({ state: "free", notice: "license_no_seat" });
  await expect(l.licenseActivate()).rejects.toEqual({ code: "license_no_seat" });
  // Freeing the other device's seat is the way out.
  await l.licenseDeactivate("dev-studio");
  expect((await l.licenseDevices()).every((d) => d.proGrant === null)).toBe(true);
});

test("buy waits for checkout, which emits Pro", async () => {
  const l = createMockLicense("free");
  const seen: LicenseState[] = [];
  const off = await l.onLicenseChanged((s) => seen.push(s));
  let done = false;
  const buying = l.licenseBuy("pro").then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  expect(seen).toEqual([]);

  l.__licenseCheckoutComplete();
  await buying;
  expect(done).toBe(true);
  expect(seen).toHaveLength(1);
  expect(seen[0]).toMatchObject({ state: "active", plan: ["pro"] });
  expect(await l.licenseAllows("pro.layouts")).toBe(true);

  off();
  l.__licenseSet({ state: "free", notice: null });
  expect(seen).toHaveLength(1);
});

test("cancel rejects the pending buy with cancelled", async () => {
  const l = createMockLicense("free");
  const buying = l.licenseBuy("pro");
  await l.licenseBuyCancel();
  await expect(buying).rejects.toEqual({ code: "cancelled" });
  expect((await l.licenseState()).state).toBe("free");
});

test("__licenseSet replaces the state and emits it", async () => {
  const l = createMockLicense("pro");
  const seen: LicenseState[] = [];
  await l.onLicenseChanged((s) => seen.push(s));
  l.__licenseSet({ state: "free", notice: "license_device_revoked" });
  expect(seen).toEqual([{ state: "free", notice: "license_device_revoked" }]);
  expect(await l.licenseState()).toEqual({ state: "free", notice: "license_device_revoked" });
});

test("deactivating this device frees it and emits", async () => {
  const l = createMockLicense("pro");
  const seen: LicenseState[] = [];
  await l.onLicenseChanged((s) => seen.push(s));
  expect(await l.licenseDeactivate()).toEqual({ state: "free", notice: null });
  expect(seen).toEqual([{ state: "free", notice: null }]);
  expect(await l.licenseActivate()).toMatchObject({ state: "active", device: { active: 2 } });
});
