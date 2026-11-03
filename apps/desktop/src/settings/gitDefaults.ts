import type { GitSettings } from "@/api";

// `GitSettings::default()` in Rust; used until the stored settings load, or when they cannot.
export const DEFAULT_GIT_SETTINGS: GitSettings = {
  branchPrefix: "git-username",
  branchPrefixCustom: "",
  refreshLocalBaseOnCreate: false,
  compareAgainstUpstream: false,
  sourceControlAi: true,
  prDraft: false,
  prGenerateOnOpen: false,
  prOpenAfterCreate: false,
};
