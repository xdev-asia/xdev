import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type RepoPatch, type RepoView } from "@/api";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "./sections";

type Field = "shortName" | "baseRef" | "worktreeRoot";
type Draft = Partial<Record<Field, string>>;
type Failure = { field: Field | "form"; code: ApiError["code"] };

const FIELDS: Field[] = ["shortName", "baseRef", "worktreeRoot"];

// Which field a refusal belongs under; anything else shows under the whole form.
function fieldOf(code: ApiError["code"]): Field | "form" {
  if (code === "bad_name" || code === "short_name_taken") return "shortName";
  if (code === "bad_ref") return "baseRef";
  if (code === "bad_path") return "worktreeRoot";
  return "form";
}

/** One form per repo: short name, base ref and worktree folder. Save sends only what changed. */
export function ReposSettings(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<ApiError["code"]>();

  useEffect(() => {
    api.workspaceList().then(setRepos, (e: unknown) => {
      setLoadError(toApiError(e).code);
      setRepos([]);
    });
  }, [api]);

  const value = (repo: RepoView, field: Field): string => drafts[repo.id]?.[field] ?? repo[field];

  // The fields whose typed value differs from what is stored, trimmed.
  function patchOf(repo: RepoView): RepoPatch {
    const patch: RepoPatch = {};
    for (const field of FIELDS) {
      const typed = value(repo, field).trim();
      if (typed !== repo[field]) patch[field] = typed;
    }
    return patch;
  }

  function edit(repo: RepoView, field: Field, next: string): void {
    setDrafts((d) => ({ ...d, [repo.id]: { ...d[repo.id], [field]: next } }));
    setSaved((s) => (s === repo.id ? null : s));
  }

  async function choose(repo: RepoView): Promise<void> {
    const path = await api.pickFolder().catch(() => null);
    if (path) edit(repo, "worktreeRoot", path);
  }

  async function save(repo: RepoView): Promise<void> {
    const patch = patchOf(repo);
    if (busy !== null || Object.keys(patch).length === 0) return;
    setBusy(repo.id);
    setSaved(null);
    try {
      const next = await api.repoUpdate(repo.id, patch);
      setRepos((list) => list?.map((r) => (r.id === repo.id ? next : r)) ?? null);
      setDrafts(({ [repo.id]: _, ...rest }) => rest);
      setFailures(({ [repo.id]: _, ...rest }) => rest);
      setSaved(repo.id);
      props.onChanged();
    } catch (e) {
      const code = toApiError(e).code;
      // The typed values stay, so the person fixes the one field.
      setFailures((f) => ({ ...f, [repo.id]: { field: fieldOf(code), code } }));
    } finally {
      setBusy(null);
    }
  }

  function message(failure: Failure): string {
    if (failure.code === "bad_name") return t("settings.repos.badName");
    if (failure.code === "bad_path" && failure.field === "worktreeRoot") return t("settings.repos.badRoot");
    return t(`error.${failure.code}`);
  }

  function errorFor(repo: RepoView, field: Field | "form"): JSX.Element | null {
    const failure = failures[repo.id];
    if (!failure || failure.field !== field) return null;
    return (
      <small id={`settings-${repo.id}-${field}-error`} className="error-text settings-error" role="alert">
        {message(failure)}
      </small>
    );
  }

  // `label` names an input that sits outside a <label>.
  function input(repo: RepoView, field: Field, mono: boolean, label?: string): JSX.Element {
    const failed = failures[repo.id]?.field === field;
    return (
      <input
        type="text"
        aria-label={label}
        className={mono ? "ws-mono" : undefined}
        name={field}
        value={value(repo, field)}
        spellCheck={false}
        disabled={busy === repo.id}
        aria-invalid={failed || undefined}
        aria-describedby={failed ? `settings-${repo.id}-${field}-error` : `settings-${repo.id}-${field}-hint`}
        onChange={(e) => edit(repo, field, e.target.value)}
      />
    );
  }

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.repos.title")}</h3>
        <p>{t("settings.repos.intro")}</p>
      </header>
      {loadError && (
        <p className="error-text" role="alert">
          {t(`error.${loadError}`)}
        </p>
      )}
      {repos && repos.length === 0 && !loadError && <p className="settings-empty">{t("settings.repos.empty")}</p>}
      {repos?.map((repo) => {
        const changed = Object.keys(patchOf(repo)).length > 0;
        return (
          <form
            key={repo.id}
            className="settings-card"
            aria-label={repo.shortName}
            onSubmit={(e) => {
              e.preventDefault();
              void save(repo);
            }}
          >
            <div className="settings-card-head">
              <strong>{repo.shortName}</strong>
              <span className="ws-mono settings-path">{repo.path}</span>
              {repo.missing && <span className="settings-tag">{t("settings.repos.missing")}</span>}
            </div>
            <div className="ws-fields">
              <label className="ws-field">
                <span>{t("settings.repos.shortName")}</span>
                {input(repo, "shortName", false)}
                {errorFor(repo, "shortName")}
                <small id={`settings-${repo.id}-shortName-hint`} className="settings-hint">
                  {t("settings.repos.shortNameNote")}
                </small>
              </label>
              <label className="ws-field">
                <span>{t("settings.repos.baseRef")}</span>
                {input(repo, "baseRef", true)}
                {errorFor(repo, "baseRef")}
                <small id={`settings-${repo.id}-baseRef-hint`} className="settings-hint">
                  {t("settings.repos.baseRefHint")}
                </small>
              </label>
              <div className="ws-field" role="group" aria-labelledby={`settings-${repo.id}-worktreeRoot-label`}>
                <span id={`settings-${repo.id}-worktreeRoot-label`}>{t("settings.repos.worktreeRoot")}</span>
                <div className="settings-row">
                  {input(repo, "worktreeRoot", true, t("settings.repos.worktreeRoot"))}
                  <button type="button" className="btn-secondary" disabled={busy === repo.id} onClick={() => void choose(repo)}>
                    {t("settings.repos.choose")}
                  </button>
                </div>
                {errorFor(repo, "worktreeRoot")}
                <small id={`settings-${repo.id}-worktreeRoot-hint`} className="settings-hint">
                  {t("settings.repos.worktreeRootHint")}
                </small>
              </div>
            </div>
            {errorFor(repo, "form")}
            <div className="settings-actions">
              {saved === repo.id && (
                <span className="settings-saved" role="status">
                  {t("settings.repos.saved")}
                </span>
              )}
              <Button type="submit" disabled={!changed || busy !== null}>
                {busy === repo.id ? t("settings.repos.saving") : t("settings.repos.save")}
              </Button>
            </div>
          </form>
        );
      })}
    </div>
  );
}
