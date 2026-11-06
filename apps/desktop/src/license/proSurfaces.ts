/** The Pro feature ids. They mirror `PRO_FEATURES` in `crates/xdev-license`. */
export type FeatureId = "pro.phone" | "pro.usage_history" | "pro.session_replay" | "pro.layouts" | "pro.early";

/**
 * The files that gate a Pro feature, by id, relative to `src/`. Only these files may use `ProGate`,
 * `allows(` or `licenseAllows(`; `freeNeverGated.test.ts` fails for any other file. Add a file here
 * in the same change that gates with it.
 */
export const PRO_SURFACES: Record<FeatureId, string[]> = {
  "pro.phone": [],
  "pro.usage_history": ["settings/UsagePage.tsx", "settings/UsageHistory.tsx", "settings/UsagePageHistory.test.tsx"],
  "pro.session_replay": [],
  "pro.layouts": ["workspace/LayoutControls.tsx"],
  "pro.early": ["settings/UpdatesSetting.tsx"],
};

/** The license plumbing: it defines or forwards the gate and never decides what is Pro. */
export const LICENSE_PLUMBING: string[] = [
  "api.ts",
  "license/ProGate.tsx",
  "license/ProGate.test.tsx",
  "license/Upsell.tsx",
  "license/Upsell.test.tsx",
  "license/useLicense.ts",
  "license/proSurfaces.ts",
  "license/freeNeverGated.test.ts",
  "mockLicense.test.ts",
];
