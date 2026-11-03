import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type ApiError,
  type HookKind,
  type HookScript,
  type RepoHooks,
  type RepoPatch,
  type RepoView,
  type ScriptSource,
  type SetupPolicy,
} from "@/api";
import { useI18n } from "@/i18n";
import { RemoveRepoDialog } from "@/workspace/RemoveRepoDialog";
import { removeRepo } from "@/workspace/removeRepo";
import type { SettingsSectionProps } from "./sections";

type Field = "shortName" | "baseRef" | "worktreeRoot" | "setupPolicy" | "scriptSource" | "localSetup" | "localArchive";
type TextField = "shortName" | "baseRef" | "worktreeRoot";
type ScriptField = "localSetup" | "localArchive";
type Draft = Partial<Record<Field, string>>;
type Failure = { field: Field | "form"; code: ApiError["code"] };

const FIELDS: Field[] = ["shortName", "baseRef", "worktreeRoot", "setupPolicy", "scriptSource", "localSetup", "localArchive"];
// Scripts keep their own whitespace; the other fields are trimmed.
const VERBATIM: Field[] = ["localSetup", "localArchive"];
const POLICIES: SetupPolicy[] = ["ask", "run", "skip"];
const SOURCES: ScriptSource[] = ["auto", "shared", "local", "both"];
const KINDS: HookKind[] = ["setup", "archive"];

// The worktree whose `xdev.toml` is shown: the first one the repo has.
function hooksPath(repo: RepoView): string | null {
  return repo.worktrees[0]?.path ?? null;
}

// Which field a refusal belongs under; anything else shows under the whole form.
function fieldOf(code: ApiError["code"]): Field | "form" {
  if (code === "bad_name" || code === "short_name_taken") return "shortName";
  if (code === "bad_ref") return "baseRef";
  if (code === "bad_path") return "worktreeRoot";
  return "form";
}

/** One form per repo: short name, base ref, worktree folder and setup scripts. Save sends only what changed. */
export function ReposSettings(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [hooks, setHooks] = useState<Record<string, RepoHooks>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // The repo Remove from xDev asks about.
  const [forgetting, setForgetting] = useState<{ repo: RepoView; error?: ApiError["code"] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<ApiError["code"]>();

  function loadHooks(repo: RepoView): void {
    const path = hooksPath(repo);
    // A repo whose file cannot be read just shows no shared scripts.
    if (path) api.repoHooks(path).then((h) => setHooks((all) => ({ ...all, [repo.id]: h })), () => {});
  }

  // Terminals of the forgotten repo's worktrees close when the window reloads its list.
  async function forget(repo: RepoView): Promise<void> {
    const code = await removeRepo({ forget: (id) => api.repoForget(id), closeWorktree: () => {} }, repo);
    if (code) return setForgetting({ repo, error: code });
    setForgetting(null);
    setRepos((list) => list?.filter((r) => r.id !== repo.id) ?? null);
    props.onChanged();
  }

  // Repo settings… in the sidebar menu asks for this repo by id.
  useEffect(() => {
    if (!props.filter || !repos?.some((r) => r.id === props.filter)) return;
    document.getElementById(`settings-repo-${props.filter}`)?.scrollIntoView?.({ block: "start" });
  }, [repos === null, props.filter]);

  useEffect(() => {
    api.workspaceList().then(
      (list) => {
        setRepos(list);
        list.forEach(loadHooks);
      },
      (e: unknown) => {
        setLoadError(toApiError(e).code);
        setRepos([]);
      },
    );
  }, [api]);

  const value = (repo: RepoView, field: Field): string => drafts[repo.id]?.[field] ?? repo[field];

  // The fields whose typed value differs from what is stored.
  function patchOf(repo: RepoView): RepoPatch {
    const patch: Record<string, string> = {};
    for (const field of FIELDS) {
      const typed = VERBATIM.includes(field) ? value(repo, field) : value(repo, field).trim();
      if (typed !== repo[field]) patch[field] = typed;
    }
    return patch as RepoPatch;
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
      loadHooks(next);
      props.onChanged();
    } catch (e) {
      const code = toApiError(e).code;
      // The typed values stay, so the person fixes the one field.
      setFailures((f) => ({ ...f, [repo.id]: { field: fieldOf(code), code } }));
    } finally {
      setBusy(null);
    }
  }

  // Trusts the hash that is shown. When the file changed since (the call is refused), the new text is shown instead.
  async function trust(repo: RepoView, kind: HookKind, script: HookScript): Promise<void> {
    const path = hooksPath(repo);
    if (!path) return;
    try {
      const next = await api.repoHookTrust(path, kind, script.hash);
      setHooks((all) => ({ ...all, [repo.id]: next }));
    } catch {
      loadHooks(repo);
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
  function input(repo: RepoView, field: TextField, mono: boolean, label?: string): JSX.Element {
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

  function scriptField(repo: RepoView, field: ScriptField): JSX.Element {
    return (
      <label className="ws-field">
        <span>{t(`settings.repos.scripts.${field}`)}</span>
        <textarea
          name={field}
          className="ws-mono"
          rows={4}
          value={value(repo, field)}
          spellCheck={false}
          disabled={busy === repo.id}
          onChange={(e) => edit(repo, field, e.target.value)}
        />
      </label>
    );
  }

  function sharedScripts(repo: RepoView): JSX.Element {
    const found = hooks[repo.id];
    const shown = KINDS.flatMap((kind) => {
      const script = found?.[kind];
      return script?.shared ? [{ kind, script }] : [];
    });
    return (
      <div className="ws-field" role="group" aria-label={t("settings.repos.scripts.shared")}>
        <span>{t("settings.repos.scripts.shared")}</span>
        {found?.parseError && (
          <small className="error-text settings-error" role="alert">
            {t("settings.repos.scripts.parseError", { error: found.parseError })}
          </small>
        )}
        {shown.length === 0 && !found?.parseError && <small className="settings-hint">{t("settings.repos.scripts.sharedNone")}</small>}
        {shown.map(({ kind, script }) => (
          <div key={kind} className="settings-script">
            <div className="settings-row">
              <strong>{t(`settings.repos.scripts.${kind}`)}</strong>
              <span className="settings-tag">{script.trusted ? t("settings.repos.scripts.trusted") : t("settings.repos.scripts.untrusted")}</span>
              {!script.trusted && (
                <button type="button" className="btn-secondary" data-trust={kind} onClick={() => void trust(repo, kind, script)}>
                  {t("settings.repos.scripts.trust")}
                </button>
              )}
            </div>
            <pre className="ws-mono settings-script-text">{script.text}</pre>
          </div>
        ))}
        {shown.some((x) => !x.script.trusted) && <small className="settings-hint">{t("settings.repos.scripts.trustNote")}</small>}
      </div>
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
            id={`settings-repo-${repo.id}`}
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
            <h4 className="settings-group">{t("settings.repos.scripts")}</h4>
            <div className="ws-fields">
              <div className="ws-field" role="radiogroup" aria-label={t("settings.repos.scripts.policy")}>
                <span>{t("settings.repos.scripts.policy")}</span>
                <div className="term-radios">
                  {POLICIES.map((p) => (
                    <label key={p} className="term-radio">
                      <input
                        type="radio"
                        name="setupPolicy"
                        value={p}
                        checked={value(repo, "setupPolicy") === p}
                        disabled={busy === repo.id}
                        onChange={() => edit(repo, "setupPolicy", p)}
                      />
                      {t(`settings.repos.scripts.policy.${p}`)}
                    </label>
                  ))}
                </div>
              </div>
              <label className="ws-field">
                <span>{t("settings.repos.scripts.source")}</span>
                <select
                  name="scriptSource"
                  value={value(repo, "scriptSource")}
                  disabled={busy === repo.id}
                  onChange={(e) => edit(repo, "scriptSource", e.target.value)}
                >
                  {SOURCES.map((x) => (
                    <option key={x} value={x}>
                      {t(`settings.repos.scripts.source.${x}`)}
                    </option>
                  ))}
                </select>
              </label>
              {scriptField(repo, "localSetup")}
              {scriptField(repo, "localArchive")}
              <small className="settings-hint">{t("settings.repos.scripts.localHint")}</small>
              {sharedScripts(repo)}
            </div>
            {errorFor(repo, "form")}
            <div className="settings-actions">
              {saved === repo.id && (
                <span className="settings-saved" role="status">
                  {t("settings.repos.saved")}
                </span>
              )}
              <button type="button" className="btn-secondary settings-remove" disabled={busy !== null} onClick={() => setForgetting({ repo })}>
                {t("settings.repos.remove")}
              </button>
              <Button type="submit" disabled={!changed || busy !== null}>
                {busy === repo.id ? t("settings.repos.saving") : t("settings.repos.save")}
              </Button>
            </div>
          </form>
        );
      })}
      {forgetting && (
        <RemoveRepoDialog
          name={forgetting.repo.shortName}
          worktrees={forgetting.repo.worktrees.length}
          tabs={[]}
          error={forgetting.error}
          onConfirm={() => void forget(forgetting.repo)}
          onCancel={() => setForgetting(null)}
        />
      )}
    </div>
  );
}
