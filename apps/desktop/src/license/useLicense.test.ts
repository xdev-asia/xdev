import { expect, it, vi } from "vitest";
import type { LicenseState } from "@xdev/bindings";
import { createMockLicense } from "@/mockLicense";
import { allowsIn, noticeOf, watchLicense } from "./useLicense";

const tick = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

it("noticeOf maps free notices and active freshness", async () => {
  const free = (notice: string | null): LicenseState => ({ state: "free", notice });
  expect(noticeOf(null)).toBeNull();
  expect(noticeOf(free(null))).toBeNull();
  expect(noticeOf(free("license_device_revoked"))).toBe("revoked");
  expect(noticeOf(free("license_no_seat"))).toBe("noSeat");
  expect(noticeOf(free("license_checkout_timeout"))).toBe("checkoutTimeout");
  expect(noticeOf(free("license_unavailable"))).toBe("unavailable");
  expect(noticeOf(await createMockLicense("pro").licenseState())).toBeNull();
  expect(noticeOf(await createMockLicense("grace").licenseState())).toBe("grace");
  expect(noticeOf(await createMockLicense("expired").licenseState())).toBe("expired");
});

it("allowsIn is true only for an active license that lists the feature", async () => {
  const pro = await createMockLicense("pro").licenseState();
  expect(allowsIn(pro, "pro.phone")).toBe(true);
  expect(allowsIn(pro, "pro.nothing")).toBe(false);
  expect(allowsIn(await createMockLicense("free").licenseState(), "pro.phone")).toBe(false);
  expect(allowsIn(null, "pro.phone")).toBe(false);
});

it("watchLicense reports the read, then each change, and stops after the returned function", async () => {
  const api = createMockLicense("free");
  const seen: string[] = [];
  const stop = watchLicense(api, (s) => seen.push(s.state));
  await tick();
  expect(seen).toEqual(["free"]);
  void api.licenseBuy("pro");
  api.__licenseCheckoutComplete();
  await tick();
  expect(seen).toEqual(["free", "active"]);
  stop();
  api.__licenseSet({ state: "free", notice: null });
  await tick();
  expect(seen).toEqual(["free", "active"]);
});

it("an event that arrives before the read answers is not overwritten by the older read", async () => {
  const api = createMockLicense("free");
  let release: (s: LicenseState) => void = () => undefined;
  const slow = new Promise<LicenseState>((r) => (release = r));
  const listener = vi.fn();
  const stop = watchLicense({ ...api, licenseState: () => slow }, listener);
  await tick();
  api.__licenseSet(await createMockLicense("pro").licenseState());
  release({ state: "free", notice: null });
  await tick();
  expect(listener).toHaveBeenCalledTimes(1);
  expect(listener.mock.calls[0]![0].state).toBe("active");
  stop();
});
