import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type ApiError,
  type ScriptKind,
  type HookScript,
  type RepoHooks,
  type RepoPatch,
  type RepoView,
  type ScriptSource,
  type SetupPolicy,
  type SparsePreset,
} from "@/api";
import { openFile } from "@/files/openFile";
import { ISSUE_VARS, effectiveIssueCommand, renderIssueCommand } from "@/issues/issueTemplate";
import { useI18n } from "@/i18n";
import { RepoBadge } from "@/workspace/RepoBadge";
import { RemoveRepoDialog } from "@/workspace/RemoveRepoDialog";
import { removeRepo } from "@/workspace/removeRepo";
import { sparseDirs } from "@/workspace/createSource";
import { addPreset, removePreset } from "@/workspace/sparsePresets";
import { colorField, ghField, iconField, identityPatch, shown, type GhState, type IdentityDraft } from "./repoIdentityForm";
import { DiskUsage } from "./DiskUsage";
import { McpConfigs } from "./McpConfigs";
import { RepoEnv } from "./RepoEnv";
import { SettingGroup, SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

type Field = "shortName" | "baseRef" | "worktreeRoot" | "setupPolicy" | "scriptSource" | "localSetup" | "localArchive" | "localIssueCommand";
type TextField = "shortName" | "baseRef" | "worktreeRoot";
type ScriptField = "localSetup" | "localArchive";
type Draft = Partial<Record<Field, string>>;
type Failure = { field: Field | "color" | "icon" | "presets" | "form"; code: ApiError["code"] };
// A preset being typed: its name and its folders, one per line.
type PresetDraft = { name: string; dirs: string; bad?: boolean };

const FIELDS: Field[] = ["shortName", "baseRef", "worktreeRoot", "setupPolicy", "scriptSource", "localSetup", "localArchive", "localIssueCommand"];
// Scripts keep their own whitespace; the other fields are trimmed.
const VERBATIM: Field[] = ["localSetup", "localArchive", "localIssueCommand"];
const POLICIES: SetupPolicy[] = ["ask", "run", "skip"];
const SOURCES: ScriptSource[] = ["auto", "shared", "local", "both"];
const KINDS: ScriptKind[] = ["setup", "archive"];

// The worktree whose `xdev.toml` is shown: the first one the repo has.
function hooksPath(repo: RepoView): string | null {
  return repo.worktrees[0]?.path ?? null;
}

// Which field a refusal belongs under; anything else shows under the whole form.
function fieldOf(code: ApiError["code"]): Failure["field"] {
  if (code === "too_large") return "localIssueCommand";
  if (code === "bad_color") return "color";
  if (code === "bad_icon") return "icon";
  if (code === "bad_name" || code === "short_name_taken") return "shortName";
  if (code === "bad_ref") return "baseRef";
  if (code === "bad_path") return "worktreeRoot";
  return "form";
}

const ISSUE_IDS = ["repos.issueCommand"];
const IDENTITY_IDS = ["repos.color", "repos.icon", "repos.ghAccount"];
const MCP_IDS = ["repos.mcpConfigs"];
const DISK_IDS = ["repos.diskUsage"];
const SCRIPT_IDS = ["repos.scriptPolicy", "repos.scriptSource", "repos.localScripts", "repos.sharedScripts", "repos.repoFile"];

/** One form per repo: short name, base ref, worktree folder and setup scripts. Save sends only what changed. */
export function ReposSettings(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [repos, setRepos] = useState<RepoView[] | null>(null);
  const [hooks, setHooks] = useState<Record<string, RepoHooks>>({});
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [failures, setFailures] = useState<Record<string, Failure>>({});
  const [busy, setBusy] = useState<string | null>(null);
  // The repo Remove from xDev asks about.
  const [forgetting, setForgetting] = useState<{ repo: RepoView; error?: ApiError["code"] } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [identity, setIdentity] = useState<Record<string, IdentityDraft>>({});
  const [gh, setGh] = useState<GhState>({ logins: null, error: null, loading: false });
  const [loadError, setLoadError] = useState<ApiError["code"]>();
  const [presetDrafts, setPresetDrafts] = useState<Record<string, PresetDraft>>({});

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
    if (!props.arg || !repos?.some((r) => r.id === props.arg)) return;
    document.getElementById(`settings-repo-${props.arg}`)?.scrollIntoView?.({ block: "start" });
  }, [repos === null, props.arg]);

  // The logins gh holds; a failure leaves the list empty with a note, and the default still works.
  function loadLogins(): void {
    setGh((g) => ({ ...g, loading: true }));
    api.ghLogins().then(
      (logins) => setGh({ logins, error: null, loading: false }),
      (e: unknown) => setGh({ logins: [], error: t(`error.${toApiError(e).code}`), loading: false }),
    );
  }

  useEffect(loadLogins, [api]);

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
    return { ...patch, ...identityPatch(repo, identity[repo.id]) } as RepoPatch;
  }

  function editIdentity(repo: RepoView, next: Partial<IdentityDraft>): void {
    setIdentity((d) => ({ ...d, [repo.id]: { ...d[repo.id], ...next } }));
    setSaved((s) => (s === repo.id ? null : s));
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
      setIdentity(({ [repo.id]: _, ...rest }) => rest);
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

  // Presets save on their own, apart from the form, so typed fields stay as they are.
  async function savePresets(repo: RepoView, presets: SparsePreset[]): Promise<boolean> {
    if (busy !== null) return false;
    setBusy(repo.id);
    try {
      const next = await api.repoUpdate(repo.id, { sparsePresets: presets });
      setRepos((list) => list?.map((r) => (r.id === repo.id ? next : r)) ?? null);
      setFailures(({ [repo.id]: _, ...rest }) => rest);
      props.onChanged();
      return true;
    } catch (e) {
      setFailures((f) => ({ ...f, [repo.id]: { field: "presets", code: toApiError(e).code } }));
      return false;
    } finally {
      setBusy(null);
    }
  }

  function editPreset(repo: RepoView, next: Partial<PresetDraft>): void {
    setPresetDrafts((d) => ({ ...d, [repo.id]: { ...(d[repo.id] ?? { name: "", dirs: "" }), ...next, bad: false } }));
  }

  async function addPresetOf(repo: RepoView): Promise<void> {
    const draft = presetDrafts[repo.id] ?? { name: "", dirs: "" };
    const dirs = sparseDirs(draft.dirs);
    const next = dirs === "bad" ? "bad" : addPreset(repo.sparsePresets ?? [], draft.name, dirs);
    if (next === "bad") return setPresetDrafts((d) => ({ ...d, [repo.id]: { ...draft, bad: true } }));
    if (await savePresets(repo, next)) setPresetDrafts(({ [repo.id]: _, ...rest }) => rest);
  }

  // Trusts the hash that is shown. When the file changed since (the call is refused), the new text is shown instead.
  async function trust(repo: RepoView, kind: ScriptKind, script: HookScript): Promise<void> {
    const path = hooksPath(repo);
    if (!path) return;
    try {
      const next = await api.repoHookTrust(path, kind, script.hash);
      setHooks((all) => ({ ...all, [repo.id]: next }));
    } catch {
      loadHooks(repo);
    }
  }

  // Trusts the shared issue command whose hash is shown; a changed file reloads and shows the new text.
  async function trustIssue(repo: RepoView): Promise<void> {
    const path = hooksPath(repo);
    const hash = hooks[repo.id]?.issueCommandHash;
    if (!path || !hash) return;
    try {
      const next = await api.repoHookTrust(path, "issueCommand", hash);
      setHooks((all) => ({ ...all, [repo.id]: next }));
    } catch {
      loadHooks(repo);
    }
  }

  function message(failure: Failure): string {
    if (failure.field === "presets" && ["bad_name", "bad_sparse", "too_large"].includes(failure.code)) return t("settings.repos.presets.bad");
    if (failure.code === "bad_name") return t("settings.repos.badName");
    if (failure.code === "too_large") return t("settings.repos.issue.tooLarge");
    if (failure.code === "bad_color") return t("settings.repos.identity.badColor");
    if (failure.code === "bad_icon") return t("settings.repos.identity.badIcon");
    if (failure.code === "bad_path" && failure.field === "worktreeRoot") return t("settings.repos.badRoot");
    return t(`error.${failure.code}`);
  }

  function errorFor(repo: RepoView, field: Failure["field"]): JSX.Element | null {
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

  // The Identity group: colour, icon and GitHub account, drawn by plain functions so the page owns the state.
  function identityRows(repo: RepoView): JSX.Element {
    const draft = identity[repo.id];
    const disabled = busy === repo.id;
    const now = shown(repo, draft);
    const ctx = { t, repo, draft, disabled, edit: (next: Partial<IdentityDraft>) => editIdentity(repo, next) };
    return (
      <>
        <div className="settings-row settings-identity-head">
          <h4 className="settings-group">{t("settings.repos.identity")}</h4>
          <RepoBadge repo={{ shortName: repo.shortName, color: now.color, icon: now.icon }} size="md" />
          <button
            type="button"
            className="btn-secondary"
            data-identity-reset
            disabled={disabled || (now.color === null && now.icon === null)}
            onClick={() => editIdentity(repo, { color: null, icon: null, iconTab: "letter" })}
          >
            {t("settings.repos.identity.reset")}
          </button>
        </div>
        <div className="ws-fields">
          <SettingRow id="repos.color" filter={filter}>
            {colorField({ ...ctx, error: errorFor(repo, "color") })}
          </SettingRow>
          <SettingRow id="repos.icon" filter={filter}>
            {iconField({ ...ctx, error: errorFor(repo, "icon") })}
          </SettingRow>
          <SettingRow id="repos.ghAccount" filter={filter}>
            {ghField({ ...ctx, error: null, gh, refresh: loadLogins })}
          </SettingRow>
        </div>
      </>
    );
  }

  // Named folder lists for a sparse checkout: each with Remove, then a name and folders to add one.
  function presetRows(repo: RepoView): JSX.Element {
    const presets = repo.sparsePresets ?? [];
    const draft = presetDrafts[repo.id] ?? { name: "", dirs: "" };
    const disabled = busy !== null;
    return (
      <div className="ws-field" role="group" aria-labelledby={`settings-${repo.id}-presets-label`}>
        <span id={`settings-${repo.id}-presets-label`}>{t("settings.repos.presets")}</span>
        {presets.length === 0 ? (
          <small className="settings-hint">{t("settings.repos.presets.none")}</small>
        ) : (
          <ul className="settings-list">
            {presets.map((p) => (
              <li key={p.name} className="settings-item" data-preset={p.name}>
                <div className="settings-item-text">
                  <strong>{p.name}</strong>
                  <small className="settings-hint ws-mono">{p.dirs.join(", ")}</small>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  disabled={disabled}
                  aria-label={t("settings.repos.presets.remove", { name: p.name })}
                  onClick={() => void savePresets(repo, removePreset(presets, p.name))}
                >
                  {t("settings.repos.presets.removeShort")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="ws-field">
          <span>{t("settings.repos.presets.name")}</span>
          <input
            type="text"
            name="presetName"
            value={draft.name}
            spellCheck={false}
            disabled={disabled}
            onChange={(e) => editPreset(repo, { name: e.target.value })}
            onKeyDown={(e) => {
              // Enter adds the preset instead of saving the whole form.
              if (e.key !== "Enter") return;
              e.preventDefault();
              void addPresetOf(repo);
            }}
          />
        </label>
        <label className="ws-field">
          <span>{t("settings.repos.presets.dirs")}</span>
          <textarea name="presetDirs" className="ws-mono" rows={3} value={draft.dirs} spellCheck={false} disabled={disabled} onChange={(e) => editPreset(repo, { dirs: e.target.value })} />
        </label>
        {draft.bad && (
          <small className="error-text settings-error" role="alert">
            {t("settings.repos.presets.bad")}
          </small>
        )}
        {errorFor(repo, "presets")}
        <div className="settings-actions settings-actions-start">
          <button type="button" className="btn-secondary" data-preset-add disabled={disabled || draft.name.trim() === "" || draft.dirs.trim() === ""} onClick={() => void addPresetOf(repo)}>
            {t("settings.repos.presets.add")}
          </button>
        </div>
        <small className="settings-hint">{t("settings.repos.presets.hint")}</small>
      </div>
    );
  }

  // The prompt template for a worktree started from an issue: the shared text (read only, trusted by hash),
  // this machine's own text, the variables it can use, and a preview with a sample issue.
  function issueRow(repo: RepoView): JSX.Element {
    const found = hooks[repo.id] ?? null;
    const local = value(repo, "localIssueCommand");
    const effective = effectiveIssueCommand(local, found);
    const sample: Record<string, string> = {
      number: "123",
      title: t("settings.repos.issue.sample.title"),
      url: "https://github.com/owner/repo/issues/123",
      body: t("settings.repos.issue.sample.body"),
      labels: "bug, ui",
      repo: repo.shortName,
    };
    return (
      <div className="ws-field" role="group" aria-label={t("settings.repos.issue")}>
        <span>{t("settings.repos.issue")}</span>
        <div className="settings-row">
          <strong>{t("settings.repos.issue.shared")}</strong>
          {found?.issueCommand && <span className="settings-tag">{found.issueCommandTrusted ? t("settings.repos.issue.trusted") : t("settings.repos.issue.untrusted")}</span>}
          {found?.issueCommand && !found.issueCommandTrusted && (
            <button type="button" className="btn-secondary" data-trust="issueCommand" onClick={() => void trustIssue(repo)}>
              {t("settings.repos.issue.trust")}
            </button>
          )}
        </div>
        {found?.issueCommand ? <pre className="ws-mono settings-script-text">{found.issueCommand}</pre> : <small className="settings-hint">{t("settings.repos.issue.sharedNone")}</small>}
        <label className="ws-field">
          <span>{t("settings.repos.issue.local")}</span>
          <textarea
            name="localIssueCommand"
            className="ws-mono"
            rows={4}
            value={local}
            spellCheck={false}
            disabled={busy === repo.id}
            aria-invalid={failures[repo.id]?.field === "localIssueCommand" || undefined}
            onChange={(e) => edit(repo, "localIssueCommand", e.target.value)}
          />
        </label>
        {errorFor(repo, "localIssueCommand")}
        <div className="ws-issue-vars" role="group" aria-label={t("settings.repos.issue.vars")}>
          {ISSUE_VARS.map((name) => (
            <button key={name} type="button" className="btn-secondary ws-issue-var" data-issue-var={name} disabled={busy === repo.id} onClick={() => edit(repo, "localIssueCommand", `${local}{${name}}`)}>
              {`{${name}}`}
            </button>
          ))}
        </div>
        <strong>{t("settings.repos.issue.preview")}</strong>
        {effective === null ? (
          <small className="settings-hint">{t("settings.repos.issue.previewBuiltIn")}</small>
        ) : (
          <pre className="ws-mono settings-script-text" data-issue-preview>
            {renderIssueCommand(effective, sample)}
          </pre>
        )}
        <small className="settings-hint">{t("settings.repos.issue.hint")}</small>
      </div>
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

  // What the file says besides scripts: the lists, what was left out, and keys this version does not read.
  function repoFile(repo: RepoView): JSX.Element {
    const found = hooks[repo.id];
    const path = hooksPath(repo);
    const tag = (trusted: boolean): JSX.Element => <span className="settings-tag">{trusted ? t("settings.repos.file.trusted") : t("settings.repos.file.untrusted")}</span>;
    return (
      <div className="ws-field" role="group" aria-label={t("settings.repos.file")}>
        <span>{t("settings.repos.file")}</span>
        <div className="settings-row">
          <strong>{t("settings.repos.file.shared")}</strong>
          {found && found.shared.length > 0 && tag(found.sharedTrusted)}
        </div>
        {found && found.shared.length > 0 ? <pre className="ws-mono settings-script-text">{found.shared.join("\n")}</pre> : <small className="settings-hint">{t("settings.repos.file.none")}</small>}
        <div className="settings-row">
          <strong>{t("settings.repos.file.tabs")}</strong>
          {found && found.tabs.length > 0 && tag(found.tabsTrusted)}
        </div>
        {found && found.tabs.length > 0 ? (
          <pre className="ws-mono settings-script-text">{found.tabs.map((x) => t("repoFile.tab.item", { title: x.title, command: x.command })).join("\n")}</pre>
        ) : (
          <small className="settings-hint">{t("settings.repos.file.none")}</small>
        )}
        {found && found.problems.length > 0 && (
          <div role="group" aria-label={t("settings.repos.file.problems")}>
            <strong>{t("settings.repos.file.problems")}</strong>
            <ul className="settings-list">
              {found.problems.map((p) => (
                <li key={p} className="error-text">{p}</li>
              ))}
            </ul>
          </div>
        )}
        {found && found.unknown.length > 0 && (
          <small className="settings-hint" role="status">
            {t("settings.repos.file.unknown", { keys: found.unknown.join(", ") })}
          </small>
        )}
        <small className="settings-hint">{t("settings.repos.file.hint")}</small>
        {path && (
          <div className="settings-actions">
            <button type="button" className="btn-secondary" data-open-file onClick={() => openFile({ worktree: path, rel: "xdev.toml" })}>
              {t("settings.repos.file.open")}
            </button>
          </div>
        )}
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
            <SettingGroup ids={IDENTITY_IDS} filter={filter}>
              {identityRows(repo)}
            </SettingGroup>
            <div className="ws-fields">
              <SettingRow id="repos.shortName" filter={filter}>
              <label className="ws-field">
                <span>{t("settings.repos.shortName")}</span>
                {input(repo, "shortName", false)}
                {errorFor(repo, "shortName")}
                <small id={`settings-${repo.id}-shortName-hint`} className="settings-hint">
                  {t("settings.repos.shortNameNote")}
                </small>
              </label>
              </SettingRow>
              <SettingRow id="repos.baseRef" filter={filter}>
              <label className="ws-field">
                <span>{t("settings.repos.baseRef")}</span>
                {input(repo, "baseRef", true)}
                {errorFor(repo, "baseRef")}
                <small id={`settings-${repo.id}-baseRef-hint`} className="settings-hint">
                  {t("settings.repos.baseRefHint")}
                </small>
              </label>
              </SettingRow>
              <SettingRow id="repos.worktreeRoot" filter={filter}>
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
              </SettingRow>
              <SettingRow id="repos.sparsePresets" filter={filter}>
                {presetRows(repo)}
              </SettingRow>
              <SettingRow id="repos.env" filter={filter}>
                <RepoEnv api={api} repo={repo} onSaved={(next) => setRepos((list) => list?.map((r) => (r.id === next.id ? next : r)) ?? null)} />
              </SettingRow>
            </div>
            <SettingGroup ids={SCRIPT_IDS} filter={filter}>
            <h4 className="settings-group">{t("settings.repos.scripts")}</h4>
            <div className="ws-fields">
              <SettingRow id="repos.scriptPolicy" filter={filter}>
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
              </SettingRow>
              <SettingRow id="repos.scriptSource" filter={filter}>
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
              </SettingRow>
              <SettingRow id="repos.localScripts" filter={filter}>
                {scriptField(repo, "localSetup")}
                {scriptField(repo, "localArchive")}
                <small className="settings-hint">{t("settings.repos.scripts.localHint")}</small>
              </SettingRow>
              <SettingRow id="repos.sharedScripts" filter={filter}>
                {sharedScripts(repo)}
              </SettingRow>
              <SettingRow id="repos.repoFile" filter={filter}>
                {repoFile(repo)}
              </SettingRow>
            </div>
            </SettingGroup>
            <SettingGroup ids={ISSUE_IDS} filter={filter}>
              <h4 className="settings-group">{t("settings.repos.issue")}</h4>
              <div className="ws-fields">
                <SettingRow id="repos.issueCommand" filter={filter}>
                  {issueRow(repo)}
                </SettingRow>
              </div>
            </SettingGroup>
            <SettingGroup ids={MCP_IDS} filter={filter}>
              <h4 className="settings-group">{t("settings.repos.mcp.title")}</h4>
              <div className="ws-fields">
                <SettingRow id="repos.mcpConfigs" filter={filter}>
                  <McpConfigs api={api} repoPath={repo.path} />
                </SettingRow>
              </div>
            </SettingGroup>
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
      <SettingGroup ids={DISK_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.repos.disk.title")}</h4>
        <SettingRow id="repos.diskUsage" filter={filter}>
          <DiskUsage api={api} />
        </SettingRow>
      </SettingGroup>
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
