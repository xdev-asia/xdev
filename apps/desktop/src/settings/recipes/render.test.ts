import { describe, expect, it } from "vitest";
import cases from "../../../src-tauri/tests/fixtures/recipes.json";
import { DEFAULT_RECIPE } from "../gitDefaults";
import { FIX_BASE_PROMPTS, RECIPE_VARS, fixPrompt, render } from ".";

// The table `recipes.rs` reads too, so the two renderers cannot drift apart.
describe("render", () => {
  for (const c of cases as { name: string; template: string; vars: Record<string, string>; expected: string }[]) {
    it(c.name, () => expect(render(c.template, c.vars)).toBe(c.expected));
  }

  it("does not take a name from the prototype", () => {
    expect(render("{toString} {constructor}", {})).toBe("{toString} {constructor}");
  });
});

describe("RECIPE_VARS", () => {
  it("starts every recipe with basePrompt and has no repeats", () => {
    for (const vars of Object.values(RECIPE_VARS)) {
      expect(vars[0]).toBe("basePrompt");
      expect(new Set(vars).size).toBe(vars.length);
    }
  });

  it("lists the variables of the Rust side", () => {
    expect(RECIPE_VARS.commitMessage).toEqual(["basePrompt", "branch", "stagedFiles", "stagedPatch", "linkedIssue"]);
    expect(RECIPE_VARS.pullRequest).toHaveLength(9);
  });
});

describe("fixPrompt", () => {
  it("sends what xDev always sent with the default template", () => {
    expect(fixPrompt("fixCommitFailure", DEFAULT_RECIPE, { branch: "feat", output: "lint failed" })).toBe(
      "The git commit hook failed. Fix the problem it reports, then stop; do not commit.\n\nlint failed",
    );
    expect(fixPrompt("fixPushFailure", DEFAULT_RECIPE, { output: "rejected" })).toBe(
      `${FIX_BASE_PROMPTS.fixPushFailure}\n\nrejected`,
    );
  });

  it("puts a custom template around the built-in prompt and the variables", () => {
    const recipe = { ...DEFAULT_RECIPE, template: "Use conventional commits.\n{basePrompt}\nBranch: {branch} {nope}" };
    const text = fixPrompt("fixCommitFailure", recipe, { branch: "feat/x", output: "boom" });
    expect(text).toBe(`Use conventional commits.\n${FIX_BASE_PROMPTS.fixCommitFailure}\n\nboom\nBranch: feat/x {nope}`);
  });

  it("describes a failed check with its link, and with its log when there is one", () => {
    const vars = { branch: "b", checkName: "build", workflow: "CI", link: "https://x/actions/runs/1" };
    const noLog = fixPrompt("fixChecks", DEFAULT_RECIPE, vars);
    expect(noLog).toBe(`${FIX_BASE_PROMPTS.fixChecks}\n\nCheck: build\nWorkflow: CI\nLink: https://x/actions/runs/1`);
    const withLog = fixPrompt("fixChecks", DEFAULT_RECIPE, { ...vars, log: "error: boom" });
    expect(withLog).toBe(`${noLog}\n\nLog:\nerror: boom`);
    // A template can place the pieces itself.
    const own = { ...DEFAULT_RECIPE, template: "{checkName}|{workflow}|{link}|{log}" };
    expect(fixPrompt("fixChecks", own, { checkName: "t" })).toBe("t|||");
  });

  it("leaves a value that looks like a variable as it is", () => {
    const text = fixPrompt("fixPushFailure", { ...DEFAULT_RECIPE, template: "{basePrompt}|{branch}" }, { branch: "main", output: "see {branch}" });
    expect(text.endsWith("see {branch}|main")).toBe(true);
  });
});
