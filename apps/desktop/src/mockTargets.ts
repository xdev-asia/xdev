import type { Api, ApiError, TargetsView } from "./api";

// Run targets in the browser mock: two detected Vercel presets, a repo preset "Staging" and a
// `[vps]` target. `?targets=empty` has none. `__targetsUntrusted(true)` makes the repo's parts untrusted.

type TargetsApi = Pick<Api, "targetsList" | "targetsTrust" | "targetsVpsNotes">;

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
    __targetsUntrusted(value) {
      untrusted = value;
    },
    __targetsTyped: () => written(),
  };
}
