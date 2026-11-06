import type { Api, ApiError, SimDevice, SimList, TargetsView } from "./api";

// Run targets in the browser mock: two detected Vercel presets, a repo preset "Staging" and a
// `[vps]` target. `?targets=empty` has none. `__targetsUntrusted(true)` makes the repo's parts untrusted.

type TargetsApi = Pick<Api, "targetsList" | "targetsTrust" | "targetsVpsNotes" | "simsList" | "simBoot">;

export type MockTargets = TargetsApi & {
  /** Marks the repo's presets as not trusted (or trusted again). */
  __targetsUntrusted(untrusted: boolean): void;
  /** What was typed into each pty, by pty id. */
  __targetsTyped(): Record<string, string>;
};

const HASH = "mock-targets-hash";
const TEXT =
  '[[deploy]]\nname = "Staging"\nrun = "make stage"\n\n[vps]\nhost = "prod-1"\ncwd = "/srv/app"\nnotes = "docs/deploy.md"\n';

function fullView(untrusted: boolean): TargetsView {
  return {
    deploy: [
      { name: "Vercel preview", run: "vercel deploy", confirm: false, source: "detected" },
      { name: "Vercel production", run: "vercel deploy --prod", confirm: true, source: "detected" },
      { name: "Staging", run: "make stage", confirm: false, source: "repo" },
    ],
    vps: { host: "prod-1", cwd: "/srv/app", notes: "docs/deploy.md" },
    trusted: !untrusted,
    hash: HASH,
    text: TEXT,
    error: null,
    vpsHostKnown: true,
  };
}

const EMPTY: TargetsView = { deploy: [], vps: null, trusted: true, hash: "", text: null, error: null, vpsHostKnown: true };

export function createMockTargets(
  written: () => Record<string, string>,
  empty: boolean = typeof location !== "undefined" && new URLSearchParams(location.search).get("targets") === "empty",
): MockTargets {
  let untrusted = false;
  return {
    targetsList: () => Promise.resolve(structuredClone(empty ? EMPTY : fullView(untrusted))),
    targetsTrust(_worktree, hash) {
      if (hash !== HASH) {
        const error: ApiError = { code: "deploy_untrusted" };
        return Promise.reject(error);
      }
      untrusted = false;
      return Promise.resolve();
    },
    targetsVpsNotes: () => Promise.resolve(empty ? null : "docs/deploy.md"),
    ...createMockSims(),
    __targetsUntrusted(value) {
      untrusted = value;
    },
    __targetsTyped: () => written(),
  };
}

// Simulators: two iOS simulators (one running) and one AVD. `?sims=none` has no tools.
const SIMS: SimDevice[] = [
  { platform: "ios", id: "MOCK-IOS-16", name: "iPhone 16", runtime: "iOS 18.0", state: "booted", serial: null },
  { platform: "ios", id: "MOCK-IOS-15", name: "iPhone 15", runtime: "iOS 17.5", state: "shutdown", serial: null },
  { platform: "android", id: "Pixel_8_API_35", name: "Pixel_8_API_35", runtime: null, state: "shutdown", serial: null },
];

const NO_SIMS: SimList = { ios: null, android: null, problems: ["targets.sim.noXcode", "targets.sim.noAndroid"] };

export function createMockSims(
  none: boolean = typeof location !== "undefined" && new URLSearchParams(location.search).get("sims") === "none",
): Pick<Api, "simsList" | "simBoot"> {
  return {
    simsList: () =>
      Promise.resolve(
        structuredClone(
          none
            ? NO_SIMS
            : {
                ios: SIMS.filter((d) => d.platform === "ios"),
                android: SIMS.filter((d) => d.platform === "android"),
                problems: [],
              },
        ),
      ),
    simBoot(ref) {
      const d = SIMS.find((s) => s.platform === ref.platform && s.id === ref.id);
      if (none || !d) {
        const error: ApiError = { code: none ? "sim_tool_missing" : "sim_not_found" };
        return Promise.reject(error);
      }
      return Promise.resolve(
        d.platform === "ios"
          ? { tabCommand: null, logCommand: `xcrun simctl spawn ${d.id} log stream --style compact --level info`, title: d.name }
          : {
              tabCommand: `emulator -avd ${d.id}`,
              logCommand: "adb wait-for-device && adb logcat -v color",
              title: d.name,
            },
      );
    },
  };
}
