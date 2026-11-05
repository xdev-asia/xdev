import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type BranchPrefixMode, type GitSettings as Git } from "@/api";
import { useI18n } from "@/i18n";
import { previewPrefix } from "./branchPrefix";
import { SettingRow, settingShown } from "./SettingRow";
import { RecipesEditor } from "./recipes/RecipesEditor";
import { BOT_OVERRIDE_MAX, overrideKey, withOverride } from "@/workspace/prComments";
import type { SettingsSectionProps } from "./sections";

const MODES: BranchPrefixMode[] = ["git-username", "custom", "none"];
// The pull request defaults, in the reference app's order.
const PR_DEFAULTS = ["prDraft", "prGenerateOnOpen", "prOpenAfterCreate"] as const;

/**
 * Settings → Git: the branch prefix new worktrees get, the compare base, whether a create first
 * updates the local base, and the Source Control agent actions with the pull request defaults.
 */
export function GitSettings(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [git, setGit] = useState<Git | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  // What the person typed. A save stores it normalized, but the box keeps the raw text so a
  // trailing `/` can be typed on the way to `team/me`.
  const [custom, setCustom] = useState("");
  const [loadError, setLoadError] = useState<ApiError["code"]>();
  const [saveError, setSaveError] = useState<ApiError["code"]>();
  const [botDraft, setBotDraft] = useState("");
  const [botCapped, setBotCapped] = useState(false);
  // Saves run one after another, so a slow early one cannot land after a later one. `latest`
  // is what the next change builds on, ahead of the re-render.
  const [queue] = useState(() => ({ tail: Promise.resolve(), latest: null as Git | null }));

  useEffect(() => {
    Promise.all([api.gitSettings(), api.gitUserName().catch(() => null)]).then(
      ([stored, name]) => {
        queue.latest = stored;
        setGit(stored);
        setCustom(stored.branchPrefixCustom);
        setUserName(name);
      },
      (e: unknown) => setLoadError(toApiError(e).code),
    );
  }, [api, queue]);

  function change(patch: Partial<Git>): void {
    if (!queue.latest) return;
    const next = { ...queue.latest, ...patch };
    queue.latest = next;
    setGit(next);
    setSaveError(undefined);
    queue.tail = queue.tail.then(() =>
      api.setGitSettings(next).then(
        () => undefined,
        (e: unknown) => setSaveError(toApiError(e).code),
      ),
    );
  }

  const header = (
    <header className="settings-head">
      <h3>{t("settings.git.title")}</h3>
      <p>{t("settings.git.intro")}</p>
    </header>
  );
  if (!git) {
    return (
      <div className="settings-page">
        {header}
        {loadError && (
          <p className="error-text" role="alert">
            {t(`error.${loadError}`)}
          </p>
        )}
      </div>
    );
  }

  function addBot(): void {
    const login = overrideKey(botDraft);
    if (login === "" || login.length > 255) return;
    const list = git!.prBotAuthorOverrides;
    if (!list.includes(login) && list.length >= BOT_OVERRIDE_MAX) return setBotCapped(true);
    setBotCapped(false);
    setBotDraft("");
    change({ prBotAuthorOverrides: withOverride(list, login, true) });
  }

  const mode = git.branchPrefix;
  const byUser = mode === "git-username";
  const preview = previewPrefix({ branchPrefix: mode, branchPrefixCustom: custom }, userName);
  const feedback =
    preview.kind === "prefix"
      ? t("settings.git.prefixWill", { prefix: preview.prefix })
      : preview.kind === "none"
        ? t("settings.git.prefixNone")
        : t(`settings.git.issue.${preview.issue}`);

  return (
    <div className="settings-page">
      {header}
      <SettingRow id="git.prefix" filter={filter}>
      <h4 className="settings-group" id="settings-git-prefix">
        {t("settings.git.prefix")}
      </h4>
      <div className="segmented settings-git-modes" role="group" aria-labelledby="settings-git-prefix">
        {MODES.map((m) => (
          <button key={m} type="button" data-mode={m} aria-pressed={mode === m} onClick={() => change({ branchPrefix: m })}>
            {t(`settings.git.mode.${m}`)}
          </button>
        ))}
      </div>
      {mode !== "none" && (
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("settings.git.prefixLabel")}</span>
            <input
              type="text"
              name="branchPrefixCustom"
              className="ws-mono"
              value={byUser ? userName ?? "" : custom}
              placeholder={byUser ? t("settings.git.noUserName") : t("settings.git.customPlaceholder")}
              readOnly={byUser}
              spellCheck={false}
              aria-invalid={preview.kind === "invalid" || undefined}
              aria-describedby="settings-git-feedback"
              onChange={(e) => {
                if (byUser) return;
                setCustom(e.target.value);
                change({ branchPrefixCustom: e.target.value });
              }}
            />
            <small
              id="settings-git-feedback"
              className={preview.kind === "invalid" ? "settings-error" : "settings-hint"}
              role={preview.kind === "invalid" ? "alert" : "status"}
            >
              {feedback}
            </small>
          </label>
        </div>
      )}
      </SettingRow>
      <SettingRow id="git.compare" filter={filter}>
      <h4 className="settings-group" id="settings-git-compare">
        {t("settings.git.compare")}
      </h4>
      <div className="segmented settings-git-modes" role="group" aria-labelledby="settings-git-compare" aria-describedby="settings-git-compare-hint">
        {[false, true].map((upstream) => (
          <button
            key={String(upstream)}
            type="button"
            data-compare={upstream ? "upstream" : "base"}
            aria-pressed={git.compareAgainstUpstream === upstream}
            onClick={() => change({ compareAgainstUpstream: upstream })}
          >
            {t(upstream ? "settings.git.compare.upstream" : "settings.git.compare.base")}
          </button>
        ))}
      </div>
      <small id="settings-git-compare-hint" className="settings-hint">
        {t("settings.git.compareHint")}
      </small>
      </SettingRow>
      <SettingRow id="git.pullPolicy" filter={filter}>
      <h4 className="settings-group" id="settings-git-pullpolicy">
        {t("settings.git.pullPolicy")}
      </h4>
      <div className="segmented settings-git-modes" role="group" aria-labelledby="settings-git-pullpolicy" aria-describedby="settings-git-pullpolicy-hint">
        {(["ff-only", "merge", "rebase", "git-config"] as const).map((policy) => (
          <button
            key={policy}
            type="button"
            data-pull-policy={policy}
            aria-pressed={git.pullPolicy === policy}
            onClick={() => change({ pullPolicy: policy })}
          >
            {t(`settings.git.pullPolicy.${policy}`)}
          </button>
        ))}
      </div>
      <small id="settings-git-pullpolicy-hint" className="settings-hint">
        {t("settings.git.pullPolicyHint")}
      </small>
      </SettingRow>
      <SettingRow id="git.groupOrder" filter={filter}>
      <h4 className="settings-group" id="settings-git-grouporder">
        {t("settings.git.groupOrder")}
      </h4>
      <div className="segmented settings-git-modes" role="group" aria-labelledby="settings-git-grouporder" aria-describedby="settings-git-grouporder-hint">
        {(["changes-first", "staged-first"] as const).map((order) => (
          <button
            key={order}
            type="button"
            data-group-order={order}
            aria-pressed={git.sourceControlGroupOrder === order}
            onClick={() => change({ sourceControlGroupOrder: order })}
          >
            {t(`settings.git.groupOrder.${order}`)}
          </button>
        ))}
      </div>
      <small id="settings-git-grouporder-hint" className="settings-hint">
        {t("settings.git.groupOrderHint")}
      </small>
      </SettingRow>
      <SettingRow id="git.refresh" filter={filter}>
      <div className="settings-item settings-git-row">
        <div className="settings-git-text">
          <strong id="settings-git-refresh">{t("settings.git.refresh")}</strong>
          <small className="settings-hint">{t("settings.git.refreshHint")}</small>
        </div>
        <button
          type="button"
          role="switch"
          className="agent-switch"
          aria-checked={git.refreshLocalBaseOnCreate}
          aria-labelledby="settings-git-refresh"
          onClick={() => change({ refreshLocalBaseOnCreate: !git.refreshLocalBaseOnCreate })}
        />
      </div>
      </SettingRow>
      <SettingRow id="git.autoRename" filter={filter}>
      <div className="settings-item settings-git-row">
        <div className="settings-git-text">
          <strong id="settings-git-autorename">{t("settings.git.autoRename.title")}</strong>
          <small className="settings-hint">{t("settings.git.autoRename.hint")}</small>
        </div>
        <button
          type="button"
          role="switch"
          className="agent-switch"
          aria-checked={git.autoRenameBranch}
          aria-labelledby="settings-git-autorename"
          onClick={() => change({ autoRenameBranch: !git.autoRenameBranch })}
        />
      </div>
      <details className="settings-advanced" data-advanced="branch-name">
        <summary>{t("settings.git.autoRename.advanced")}</summary>
        <RecipesEditor
          api={api}
          recipes={git.recipes}
          onChange={(recipes) => change({ recipes })}
          ids={["branchName"]}
          heading={false}
        />
      </details>
      </SettingRow>
      {(settingShown(filter, "git.ai") || settingShown(filter, "git.pr")) && (
        <h4 className="settings-group" id="settings-git-ai-title">
          {t("settings.git.ai.title")}
        </h4>
      )}
      <SettingRow id="git.ai" filter={filter}>
      <div className="settings-item settings-git-row">
        <div className="settings-git-text">
          <strong id="settings-git-ai">{t("settings.git.ai.show")}</strong>
          <small className="settings-hint">{t("settings.git.ai.showHint")}</small>
        </div>
        <button
          type="button"
          role="switch"
          className="agent-switch"
          aria-checked={git.sourceControlAi}
          aria-labelledby="settings-git-ai"
          onClick={() => change({ sourceControlAi: !git.sourceControlAi })}
        />
      </div>
      </SettingRow>
      {git.sourceControlAi && (
        <SettingRow id="git.pr" filter={filter}>
        <fieldset className="settings-git-checks">
          <legend>{t("settings.git.pr.title")}</legend>
          {PR_DEFAULTS.map((key) => (
            <label key={key} className="settings-git-check">
              <input type="checkbox" name={key} checked={git[key]} onChange={() => change({ [key]: !git[key] })} />
              {t(`settings.git.pr.${key}`)}
            </label>
          ))}
        </fieldset>
        </SettingRow>
      )}
      {git.sourceControlAi && <RecipesEditor api={api} recipes={git.recipes} onChange={(recipes) => change({ recipes })} />}
      <SettingRow id="git.botAuthors" filter={filter}>
        <h4 className="settings-group" id="settings-git-bots">
          {t("settings.git.botAuthors.title")}
        </h4>
        <small className="settings-hint">{t("settings.git.botAuthors.hint")}</small>
        <form
          className="ws-fields settings-git-bots-add"
          onSubmit={(e) => {
            e.preventDefault();
            addBot();
          }}
        >
          <label className="ws-field">
            <span>{t("settings.git.botAuthors.label")}</span>
            <input type="text" name="botAuthor" className="ws-mono" value={botDraft} spellCheck={false} maxLength={255} onChange={(e) => setBotDraft(e.target.value)} />
          </label>
          <button type="submit" className="ws-checks-btn" disabled={overrideKey(botDraft) === ""}>
            {t("settings.git.botAuthors.add")}
          </button>
        </form>
        {botCapped && (
          <p className="error-text" role="alert">
            {t("settings.git.botAuthors.limit")}
          </p>
        )}
        {git.prBotAuthorOverrides.length === 0 ? (
          <p className="ws-empty">{t("settings.git.botAuthors.none")}</p>
        ) : (
          <ul className="settings-git-bots">
            {git.prBotAuthorOverrides.map((login) => (
              <li key={login} data-bot={login}>
                <span className="ws-mono">{login}</span>
                <button
                  type="button"
                  className="ws-checks-btn"
                  aria-label={t("settings.git.botAuthors.remove", { login })}
                  onClick={() => {
                    setBotCapped(false);
                    change({ prBotAuthorOverrides: withOverride(git.prBotAuthorOverrides, login, false) });
                  }}
                >
                  {t("settings.git.botAuthors.removeShort")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </SettingRow>
      {saveError && (
        <p className="error-text" role="alert">
          {t(`error.${saveError}`)}
        </p>
      )}
    </div>
  );
}
