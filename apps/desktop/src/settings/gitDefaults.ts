import type { GitSettings, Recipe } from "@/api";

// `Recipe::default()`: the built-in prompt, the default agent.
export const DEFAULT_RECIPE: Recipe = { agent: null, args: [], template: "{basePrompt}" };

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
  recipes: {
    commitMessage: DEFAULT_RECIPE,
    pullRequest: DEFAULT_RECIPE,
    fixCommitFailure: DEFAULT_RECIPE,
    fixPushFailure: DEFAULT_RECIPE,
    fixChecks: DEFAULT_RECIPE,
  },
};
