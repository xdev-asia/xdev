import type { Recipe } from "@/api";
import { render } from "./render";

export { render };

// Longer is cut when saved (`RECIPE_TEMPLATE_MAX` in settings.rs).
export const RECIPE_TEMPLATE_MAX = 16 * 1024;

export type RecipeId =
  | "commitMessage"
  | "pullRequest"
  | "fixCommitFailure"
  | "fixPushFailure"
  | "fixChecks"
  | "addressComments"
  | "branchName"
  | "resolveConflicts"
  | "reviewHunk";
// The recipes in the order the editor lists them.
export const RECIPE_IDS: readonly RecipeId[] = [
  "commitMessage",
  "pullRequest",
  "fixCommitFailure",
  "fixPushFailure",
  "fixChecks",
  "addressComments",
  "resolveConflicts",
  "reviewHunk",
];
export type FixRecipeId = "fixCommitFailure" | "fixPushFailure" | "fixChecks" | "addressComments" | "resolveConflicts";

// The variables each recipe can name; `{basePrompt}` first, as in the editor's chips.
export const RECIPE_VARS: Record<RecipeId, readonly string[]> = {
  commitMessage: ["basePrompt", "branch", "stagedFiles", "stagedPatch", "linkedIssue"],
  pullRequest: [
    "basePrompt",
    "branch",
    "baseBranch",
    "currentTitle",
    "currentBody",
    "commitSummary",
    "changedFiles",
    "patch",
    "linkedIssue",
  ],
  fixCommitFailure: ["basePrompt", "branch", "output"],
  fixPushFailure: ["basePrompt", "branch", "output"],
  fixChecks: ["basePrompt", "branch", "checkName", "workflow", "link", "log"],
  addressComments: ["basePrompt", "branch", "prNumber", "prUrl", "comments"],
  resolveConflicts: ["basePrompt", "branch", "operation", "files", "onto"],
  branchName: ["basePrompt", "firstPrompt", "assistantMessage"],
  reviewHunk: ["basePrompt", "file", "hunk"],
};

// The first lines of each fix action's built-in prompt; what the action found follows them.
export const FIX_BASE_PROMPTS: Record<FixRecipeId, string> = {
  fixCommitFailure: "The git commit hook failed. Fix the problem it reports, then stop; do not commit.",
  fixPushFailure: "The git push failed. Fix the problem it reports, then stop; do not push.",
  fixChecks:
    "A check failed on this branch's pull request. Find the cause in its log, fix it here, then stop; do not commit or push.",
  addressComments:
    "Inspect and fix the selected review feedback on this branch's pull request, then stop; do not commit, push, resolve or reply on GitHub.",
  resolveConflicts:
    "A git operation stopped on merge conflicts. Resolve the conflicts in the files below, then stage them with git add and stop; do not continue, commit or abort the operation.",
};

function basePrompt(id: RecipeId, vars: Record<string, string>): string {
  if (id === "fixCommitFailure" || id === "fixPushFailure") {
    return `${FIX_BASE_PROMPTS[id]}\n\n${vars.output ?? ""}`;
  }
  if (id === "fixChecks") {
    const found = [
      `Check: ${vars.checkName ?? ""}`,
      vars.workflow ? `Workflow: ${vars.workflow}` : "",
      vars.link ? `Link: ${vars.link}` : "",
    ].filter(Boolean);
    // Without a log (R5) the link is what the agent has to go on.
    const log = vars.log ? `\n\nLog:\n${vars.log}` : "";
    return `${FIX_BASE_PROMPTS[id]}\n\n${found.join("\n")}${log}`;
  }
  if (id === "addressComments") {
    // The action builds the whole prompt (PR, rules, the untrusted-data line, the JSON).
    return vars.basePrompt ?? `${FIX_BASE_PROMPTS[id]}

${vars.comments ?? ""}`;
  }
  if (id === "resolveConflicts") {
    const found = [
      `Operation: ${vars.operation ?? ""}`,
      vars.onto ? `Onto: ${vars.onto}` : "",
      `Files:\n${vars.files ?? ""}`,
    ].filter(Boolean);
    return `${FIX_BASE_PROMPTS[id]}\n\n${found.join("\n")}`;
  }
  return vars.basePrompt ?? "";
}

/**
 * The prompt a recipe sends: its template over the built-in prompt and `vars`. `{basePrompt}` is
 * the action's own prompt with what it found, so the default template sends what xDev always did.
 * A variable `vars` lacks is empty.
 */
export function fixPrompt(id: RecipeId, recipe: Recipe, vars: Record<string, string>): string {
  const all: Record<string, string> = Object.fromEntries(RECIPE_VARS[id].map((name) => [name, ""]));
  Object.assign(all, vars);
  all.basePrompt = basePrompt(id, vars);
  return render(recipe.template, all);
}
