import type { Recipe } from "@/api";
import { render } from "./render";

export { render };

export type RecipeId = "commitMessage" | "pullRequest" | "fixCommitFailure" | "fixPushFailure" | "fixChecks";
export type FixRecipeId = "fixCommitFailure" | "fixPushFailure" | "fixChecks";

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
};

// The first lines of each fix action's built-in prompt; what the action found follows them.
export const FIX_BASE_PROMPTS: Record<FixRecipeId, string> = {
  fixCommitFailure: "",
  fixPushFailure: "",
  fixChecks: "",
};

/** The prompt a fix action sends: its recipe's template over the built-in prompt and `vars`. */
export function fixPrompt(id: RecipeId, recipe: Recipe, vars: Record<string, string>): string {
  // The prompts arrive with the tests of U1.
  void id;
  void vars;
  return recipe.template;
}
