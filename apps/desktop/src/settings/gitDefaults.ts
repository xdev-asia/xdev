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
  autoRenameBranch: true,
  sourceControlGroupOrder: "changes-first",
  prBotAuthorOverrides: [],
  pullPolicy: "ff-only",
  issuesDefaultView: "all",
  showIssuesTab: true,
  recipes: {
    commitMessage: { ...DEFAULT_RECIPE, args: [] },
    pullRequest: { ...DEFAULT_RECIPE, args: [] },
    fixCommitFailure: { ...DEFAULT_RECIPE, args: [] },
    fixPushFailure: { ...DEFAULT_RECIPE, args: [] },
    fixChecks: { ...DEFAULT_RECIPE, args: [] },
    branchName: { ...DEFAULT_RECIPE, args: [] },
    resolveConflicts: { ...DEFAULT_RECIPE, args: [] },
    addressComments: { ...DEFAULT_RECIPE, args: [] },
  },
  worktreeDir: "",
  worktreeDirHistory: [],
  localBaseRefreshTipDismissed: false,
};
