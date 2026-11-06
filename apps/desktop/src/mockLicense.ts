import type { DeviceRow, LicenseState } from "@xdev/bindings";
import type { Api, ApiError } from "./api";

// The license contract in the browser mock. Pick a state with `?license=free|pro|grace|expired|noseat`
// (default free). `licenseBuy` waits until `__licenseCheckoutComplete()`; `__licenseSet` swaps the state.
// No network.

type LicenseApi = Pick<
  Api,
  | "licenseState"
  | "licenseRefresh"
  | "licenseActivate"
  | "licenseDeactivate"
  | "licenseDevices"
  | "licenseBuy"
  | "licenseBuyCancel"
  | "licenseAllows"
  | "onLicenseChanged"
>;

export type MockLicense = LicenseApi & {
  /** The checkout finished in the browser: this device turns Pro, `license://changed` fires, and the pending `licenseBuy` resolves. */
  __licenseCheckoutComplete(): void;
  /** Replaces the state and emits `license://changed`. */
  __licenseSet(state: LicenseState): void;
};

export type LicenseMockMode = "free" | "pro" | "grace" | "expired" | "noseat";

const MODES: readonly LicenseMockMode[] = ["free", "pro", "grace", "expired", "noseat"];

/** This device in the mock. */
export const MOCK_DEVICE_ID = "dev-this";
export const MOCK_FINGERPRINT = "mockFingerprint0123456";
const MOCK_GRANT = "grant-pro-1";
const PRO_FEATURES = ["pro.phone", "pro.usage_history", "pro.session_replay", "pro.layouts", "pro.early"];
// 2027-11-06, a year after the mock's purchase.
const UPDATES_UNTIL = 1825545600;

/** `?license=…` from a query string; anything else is free. */
export function licenseModeFrom(search: string): LicenseMockMode {
  const mode = new URLSearchParams(search).get("license");
  return MODES.find((m) => m === mode) ?? "free";
}

function freeState(notice: string | null = null): LicenseState {
  return { state: "free", notice };
}

function proState(freshness: Extract<LicenseState, { state: "active" }>["freshness"], active = 1, max = 2): LicenseState {
  return {
    state: "active",
    plan: ["pro"],
    features: [...PRO_FEATURES],
    freshness,
    pro: { grant: MOCK_GRANT, perpetual: true, updatesUntil: UPDATES_UNTIL },
    syncUntil: null,
    team: null,
    device: { fingerprint: MOCK_FINGERPRINT, max, active },
  };
}

function initialState(mode: LicenseMockMode): LicenseState {
  switch (mode) {
    case "pro":
      return proState({ kind: "fresh" });
    case "grace":
      return proState({ kind: "grace", daysOffline: 9 });
    case "expired":
      return proState({ kind: "expired" });
    case "noseat":
      // Pro is bought, but every seat is on another device.
      return freeState("license_no_seat");
    case "free":
      return freeState();
  }
}

function initialDevices(mode: LicenseMockMode): DeviceRow[] {
  const thisHasPro = mode === "pro" || mode === "grace" || mode === "expired";
  const otherHasPro = mode !== "free";
  return [
    {
      id: MOCK_DEVICE_ID,
      name: "This computer",
      platform: "macos",
      fingerprint: MOCK_FINGERPRINT,
      createdAt: 1767225600,
      lastSeenAt: 1793923200,
      revokedAt: null,
      proGrant: thisHasPro ? MOCK_GRANT : null,
    },
    {
      id: "dev-studio",
      name: "studio-mac",
      platform: "macos",
      fingerprint: "studioFingerprint01234",
      createdAt: 1767312000,
      lastSeenAt: 1793836800,
      revokedAt: null,
      proGrant: otherHasPro ? MOCK_GRANT : null,
    },
  ];
}

function reject(code: ApiError["code"]): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

export function createMockLicense(
  mode: LicenseMockMode = typeof location !== "undefined" ? licenseModeFrom(location.search) : "free",
): MockLicense {
  let state = initialState(mode);
  let devices = initialDevices(mode);
  const listeners = new Set<(s: LicenseState) => void>();
  let checkout: { resolve: () => void; reject: (e: ApiError) => void } | null = null;

  const set = (next: LicenseState) => {
    state = structuredClone(next);
    for (const cb of listeners) cb(structuredClone(state));
  };
  const seatsInUse = () => devices.filter((d) => d.revokedAt === null && d.proGrant !== null).length;
  const setGrant = (id: string, grant: string | null) => {
    devices = devices.map((d) => (d.id === id ? { ...d, proGrant: grant } : d));
  };

  return {
    licenseState: () => Promise.resolve(structuredClone(state)),
    licenseRefresh: () => Promise.resolve(structuredClone(state)),
    licenseActivate() {
      if (state.state === "active") return Promise.resolve(structuredClone(state));
      // The one seat is on another device until that device is moved off.
      if (mode === "noseat" && seatsInUse() >= 1) return reject("license_no_seat");
      // No grant to activate: the crate maps the service's no_grant to unavailable.
      if (!devices.some((d) => d.proGrant !== null)) return reject("license_unavailable");
      setGrant(MOCK_DEVICE_ID, MOCK_GRANT);
      set(proState({ kind: "fresh" }, seatsInUse()));
      return Promise.resolve(structuredClone(state));
    },
    licenseDeactivate(deviceId) {
      const id = deviceId ?? MOCK_DEVICE_ID;
      if (!devices.some((d) => d.id === id)) return reject("license_unavailable");
      setGrant(id, null);
      if (id === MOCK_DEVICE_ID) set(freeState());
      else if (state.state === "active") set({ ...state, device: { ...state.device, active: seatsInUse() } });
      return Promise.resolve(structuredClone(state));
    },
    licenseDevices: () => Promise.resolve(structuredClone(devices)),
    licenseBuy() {
      checkout?.reject({ code: "cancelled" });
      return new Promise<void>((resolve, rejectBuy) => {
        checkout = { resolve, reject: rejectBuy };
      });
    },
    licenseBuyCancel() {
      checkout?.reject({ code: "cancelled" });
      checkout = null;
      return Promise.resolve();
    },
    licenseAllows: (feature) => Promise.resolve(state.state === "active" && state.features.includes(feature)),
    onLicenseChanged(cb) {
      listeners.add(cb);
      return Promise.resolve(() => void listeners.delete(cb));
    },
    __licenseCheckoutComplete() {
      setGrant(MOCK_DEVICE_ID, MOCK_GRANT);
      // A purchase buys one seat.
      set(proState({ kind: "fresh" }, seatsInUse(), 1));
      checkout?.resolve();
      checkout = null;
    },
    __licenseSet: set,
  };
}
