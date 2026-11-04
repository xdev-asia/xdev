import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, GitRecipes, ProfileView, Recipe } from "@/api";
import { useI18n } from "@/i18n";
import { DEFAULT_RECIPE } from "../gitDefaults";
import { joinArgs, splitArgs } from "./args";
import { RECIPE_IDS, RECIPE_TEMPLATE_MAX, RECIPE_VARS, render, type RecipeId } from ".";
import { RECIPE_SAMPLES } from "./samples";

// Only these have a runner, so only they can draft (a fix action runs in a terminal tab). The branch
// name is asked of an agent without tools, like a draft.
const DRAFTS: readonly RecipeId[] = ["commitMessage", "pullRequest", "branchName"];
type Caret = { start: number; end: number };

function sameRecipe(a: Recipe, b: Recipe): boolean {
  return a.agent === b.agent && a.template === b.template && joinArgs(a.args) === joinArgs(b.args);
}

/** The text with `insert` in place of the selection. */
export function insertAt(text: string, caret: Caret, insert: string): { text: string; caret: Caret } {
  const start = Math.min(caret.start, text.length);
  const end = Math.min(Math.max(caret.end, start), text.length);
  const next = text.slice(0, start) + insert + text.slice(end);
  const at = start + insert.length;
  return { text: next, caret: { start: at, end: at } };
}

/**
 * Settings → Git → Recipes: one row per agent action with its agent, extra arguments (drafts only),
 * template, variable chips and a preview with sample values.
 */
export function RecipesEditor(props: {
  api: Api;
  recipes: GitRecipes;
  onChange(next: GitRecipes): void;
  /** The recipes to list, in order; all of the Source Control ones by default. */
  ids?: readonly RecipeId[];
  /** The title and the intro above the rows; on by default. */
  heading?: boolean;
}): JSX.Element {
  const { api, recipes, onChange, ids = RECIPE_IDS, heading = true } = props;
  const { t } = useI18n();
  const [profiles, setProfiles] = useState<ProfileView[]>([]);
  // What is typed in an args box, so a trailing space or quote survives until it is a real arg.
  const [argText, setArgText] = useState<Partial<Record<RecipeId, string>>>({});
  const [carets, setCarets] = useState<Partial<Record<RecipeId, Caret>>>({});

  useEffect(() => {
    api.profiles().then(
      (view) => setProfiles(view.profiles.filter((p) => p.profile.enabled)),
      () => setProfiles([]),
    );
  }, [api]);

  function change(id: RecipeId, patch: Partial<Recipe>): void {
    onChange({ ...recipes, [id]: { ...recipes[id], ...patch } });
  }

  function insertVariable(id: RecipeId, name: string): void {
    const template = recipes[id].template;
    const { text, caret } = insertAt(template, carets[id] ?? { start: template.length, end: template.length }, `{${name}}`);
    setCarets((c) => ({ ...c, [id]: caret }));
    change(id, { template: text });
    // Back to the box with the caret after the variable, once it shows the new text.
    if (typeof document === "undefined") return;
    setTimeout(() => {
      const box = document.getElementById(`recipe-${id}-template`) as HTMLTextAreaElement | null;
      box?.focus();
      box?.setSelectionRange(caret.start, caret.end);
    }, 0);
  }

  function remember(id: RecipeId, box: { selectionStart: number; selectionEnd: number }): void {
    setCarets((c) => ({ ...c, [id]: { start: box.selectionStart, end: box.selectionEnd } }));
  }

  return (
    <div className="recipes" role="group" aria-labelledby={heading ? "settings-git-recipes-title" : undefined}>
      {heading && (
        <>
          <h4 className="settings-group" id="settings-git-recipes-title">
            {t("settings.git.recipes.title")}
          </h4>
          <p className="settings-hint">{t("settings.git.recipes.intro")}</p>
        </>
      )}
      {ids.map((id) => {
        const recipe = recipes[id];
        const draft = DRAFTS.includes(id);
        const options = draft ? profiles.filter((p) => p.profile.cli === "claude" || p.profile.cli === "codex") : profiles;
        const known = recipe.agent === null || options.some((p) => p.profile.id === recipe.agent);
        const sample = { ...RECIPE_SAMPLES, basePrompt: t("settings.git.recipes.sampleBase") };
        return (
          <details key={id} className="recipe" data-recipe={id}>
            <summary>
              <strong>{t(`settings.git.recipes.${id}`)}</strong>
              {!sameRecipe(recipe, DEFAULT_RECIPE) && <span className="recipe-edited" aria-hidden="true">*</span>}
            </summary>
            <div className="ws-fields">
              <label className="ws-field">
                <span>{t("settings.git.recipes.agent")}</span>
                <select
                  name={`recipe-${id}-agent`}
                  value={recipe.agent ?? ""}
                  onChange={(e) => change(id, { agent: e.target.value === "" ? null : e.target.value })}
                >
                  <option value="">{t("settings.git.recipes.defaultAgent")}</option>
                  {options.map((p) => (
                    <option key={p.profile.id} value={p.profile.id}>
                      {p.profile.name}
                    </option>
                  ))}
                  {!known && (
                    <option value={recipe.agent ?? ""}>{t("settings.git.recipes.unsupportedAgent", { name: recipe.agent ?? "" })}</option>
                  )}
                </select>
                {draft && <small className="settings-hint">{t("settings.git.recipes.draftAgentHint")}</small>}
              </label>
              {draft && (
                <label className="ws-field">
                  <span>{t("settings.git.recipes.args")}</span>
                  <input
                    type="text"
                    name={`recipe-${id}-args`}
                    className="ws-mono"
                    value={argText[id] ?? joinArgs(recipe.args)}
                    spellCheck={false}
                    onChange={(e) => {
                      setArgText((a) => ({ ...a, [id]: e.target.value }));
                      change(id, { args: splitArgs(e.target.value) });
                    }}
                  />
                  <small className="settings-hint">{t("settings.git.recipes.argsHint")}</small>
                </label>
              )}
              <label className="ws-field">
                <span>{t("settings.git.recipes.template")}</span>
                <textarea
                  id={`recipe-${id}-template`}
                  name={`recipe-${id}-template`}
                  className="ws-mono"
                  rows={6}
                  value={recipe.template}
                  spellCheck={false}
                  onChange={(e) => {
                    remember(id, e.target);
                    change(id, { template: e.target.value });
                  }}
                  onSelect={(e) => remember(id, e.currentTarget)}
                  onBlur={(e) => remember(id, e.currentTarget)}
                />
                {recipe.template.length > RECIPE_TEMPLATE_MAX && (
                  <small className="settings-error" role="alert">
                    {t("settings.git.recipes.tooLong", { max: RECIPE_TEMPLATE_MAX })}
                  </small>
                )}
              </label>
            </div>
            <div className="recipe-vars" role="group" aria-label={t("settings.git.recipes.variables")}>
              {RECIPE_VARS[id].map((name) => (
                <button
                  key={name}
                  type="button"
                  className="btn-secondary recipe-var ws-mono"
                  data-var={name}
                  title={t("settings.git.recipes.insert", { name: `{${name}}` })}
                  // A press must not take the focus (and the selection) out of the template box.
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => insertVariable(id, name)}
                >
                  {`{${name}}`}
                </button>
              ))}
            </div>
            <div className="recipe-preview">
              <span className="settings-hint">{t("settings.git.recipes.preview")}</span>
              <pre className="ws-mono" aria-label={t("settings.git.recipes.preview")}>
                {render(recipe.template, sample)}
              </pre>
            </div>
            <button
              type="button"
              className="btn-secondary"
              data-reset={id}
              disabled={sameRecipe(recipe, DEFAULT_RECIPE)}
              onClick={() => {
                setArgText((a) => ({ ...a, [id]: undefined }));
                change(id, { ...DEFAULT_RECIPE, args: [] });
              }}
            >
              {t("settings.git.recipes.reset")}
            </button>
          </details>
        );
      })}
    </div>
  );
}
