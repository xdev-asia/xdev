import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type BranchPrefixMode, type GitSettings as Git } from "@/api";
import { useI18n } from "@/i18n";
import { previewPrefix } from "./branchPrefix";
import type { SettingsSectionProps } from "./sections";

const MODES: BranchPrefixMode[] = ["git-username", "custom", "none"];

/** Settings → Git: the branch prefix new worktrees get, and whether a create first updates the local base. */
export function GitSettings(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [git, setGit] = useState<Git | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  // What the person typed. A save stores it normalized, but the box keeps the raw text so a
  // trailing `/` can be typed on the way to `team/me`.
  const [custom, setCustom] = useState("");
  const [loadError, setLoadError] = useState<ApiError["code"]>();
  const [saveError, setSaveError] = useState<ApiError["code"]>();
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
      {saveError && (
        <p className="error-text" role="alert">
          {t(`error.${saveError}`)}
        </p>
      )}
    </div>
  );
}
