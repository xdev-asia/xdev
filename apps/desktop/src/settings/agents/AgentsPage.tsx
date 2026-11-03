import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type Account,
  type ApiError,
  type Approvals,
  type ProfilesView,
  type ProfileView,
  type StatusSettings,
} from "@/api";
import { useProfiles } from "@/agents/profileStore";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "@/settings/sections";
import { freeId } from "./agentForm";
import { ProfileEditor } from "./ProfileEditor";
import { ShellsSection } from "./ShellsSection";

/** Settings → Agents: the Approvals switch, defaults, agent profiles, shells and Status hooks. */
export function AgentsPage(props: SettingsSectionProps & { onStatusSaved?(settings: StatusSettings): void }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const store = useProfiles();
  const [view, setView] = useState<ProfilesView | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  // A profile id, `"new"` for a custom profile being added, or null.
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmSkip, setConfirmSkip] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  // The status channel settings; this page owns only `hooks`.
  const [status, setStatus] = useState<StatusSettings | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);

  useEffect(() => {
    api.profiles().then(setView, (e) => setError(toApiError(e).code));
    api.accounts().then((a) => setAccounts(a.accounts), () => setAccounts([]));
    api.statusSettings().then(setStatus, (e) => setError(toApiError(e).code));
  }, [api]);

  // Status hooks apply to agent tabs started after the change; open tabs keep their flags.
  async function toggleHooks(): Promise<void> {
    if (statusBusy || !status) return;
    setStatusBusy(true);
    setError(undefined);
    try {
      const stored = await api.statusSettingsPut({ ...status, hooks: !status.hooks });
      setStatus(stored);
      props.onStatusSaved?.(stored);
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setStatusBusy(false);
    }
  }

  // Each write returns the whole view; the workspace's copy follows so the `+` menu stays current.
  async function act(run: () => Promise<ProfilesView>, after?: () => void): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await run();
      setView(next);
      store.update(next);
      after?.();
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  if (!view) {
    return (
      <div className="settings-page">
        <header className="settings-head">
          <h3>{t("settings.agents.title")}</h3>
        </header>
        {error && (
          <p className="error-text" role="alert">
            {t(`error.${error}`)}
          </p>
        )}
      </div>
    );
  }
  const current = view;

  const defaults = (approvals: Approvals, agent: string, shell: string) =>
    act(() => api.profilesDefaults(approvals, agent, shell));

  function pickApprovals(next: Approvals): void {
    if (next === current.approvals) return;
    if (next === "skip") setConfirmSkip(true);
    else void defaults("ask", current.defaultAgent, current.defaultShell);
  }

  const toggle = (p: ProfileView) => act(() => api.profilePut({ ...p.profile, enabled: !p.profile.enabled }));
  const close = () => setEditing(null);
  const editingView = editing === "new" ? null : (current.profiles.find((p) => p.profile.id === editing) ?? null);
  const taken = current.profiles.map((p) => p.profile.id);
  const agents = current.profiles.filter((p) => p.profile.enabled || p.profile.id === current.defaultAgent);

  const editor = (
    <ProfileEditor
      key={editing ?? ""}
      view={editingView}
      newId={freeId("", taken, "custom")}
      accounts={accounts}
      busy={busy}
      error={error}
      onSave={(p) => {
        const id = editing === "new" ? freeId(p.name, taken, "custom") : p.id;
        void act(() => api.profilePut({ ...p, id }), close);
      }}
      onReset={(id) => void act(() => api.profileReset(id), close)}
      onRemove={(id) => void act(() => api.profileRemove(id), close)}
      onCancel={close}
    />
  );

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.agents.title")}</h3>
        <p>{t("settings.agents.intro")}</p>
      </header>
      {error && editing === null && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <h4 className="settings-group">{t("settings.agents.approvals")}</h4>
      <div className="agent-seg" role="group" aria-label={t("settings.agents.approvals")}>
        <button type="button" aria-pressed={current.approvals === "ask"} disabled={busy} onClick={() => pickApprovals("ask")}>
          {t("settings.agents.approvals.ask")}
        </button>
        <button
          type="button"
          className="agent-seg-skip"
          aria-pressed={current.approvals === "skip"}
          disabled={busy}
          onClick={() => pickApprovals("skip")}
        >
          {t("settings.agents.approvals.skip")}
        </button>
      </div>
      <p className="settings-empty">{t(`settings.agents.approvals.${current.approvals}Hint`)}</p>

      <h4 className="settings-group">{t("settings.agents.defaults")}</h4>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.agents.defaultAgent")}</span>
          <select
            value={current.defaultAgent}
            disabled={busy}
            data-field="defaultAgent"
            onChange={(e) => void defaults(current.approvals, e.target.value, current.defaultShell)}
          >
            {agents.map((p) => (
              <option key={p.profile.id} value={p.profile.id}>
                {p.profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className="ws-field">
          <span>{t("settings.agents.defaultShell")}</span>
          <select
            value={current.defaultShell}
            disabled={busy}
            data-field="defaultShell"
            onChange={(e) => void defaults(current.approvals, current.defaultAgent, e.target.value)}
          >
            {current.shells.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <h4 className="settings-group">{t("settings.agents.profiles")}</h4>
      <ul className="settings-list">
        {current.profiles.map((p) => (
          <li key={p.profile.id} className="settings-item" data-profile={p.profile.id}>
            <div className="settings-item-text">
              <span className="agent-dot" data-installed={p.installed} aria-hidden="true" />
              <strong>{p.profile.name}</strong>
              <span className="ws-mono settings-path">{p.path ?? t("settings.agents.notFound")}</span>
              {p.permissions === "skip" && <span className="agent-skip">{t("settings.agents.skip")}</span>}
              {p.followsApprovals && <span className="settings-path">{t("settings.agents.follows")}</span>}
            </div>
            <div className="settings-actions">
              <button
                type="button"
                role="switch"
                className="agent-switch"
                aria-checked={p.profile.enabled}
                aria-label={t("settings.agents.enabled", { name: p.profile.name })}
                disabled={busy}
                onClick={() => void toggle(p)}
              />
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => setEditing(p.profile.id)}>
                {t("settings.agents.edit")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      {editing !== null ? (
        editor
      ) : (
        <div className="settings-actions settings-actions-start">
          <button type="button" className="btn-secondary" onClick={() => setEditing("new")}>
            {t("settings.agents.addProfile")}
          </button>
        </div>
      )}

      <ShellsSection
        shells={current.shells}
        busy={busy}
        onAdd={(s) => void act(() => api.shellPut(s))}
        onRemove={(id) => void act(() => api.shellRemove(id))}
      />

      <h4 className="settings-group">{t("settings.agents.statusHooks")}</h4>
      <ul className="settings-list" data-section="status-hooks">
        <li className="settings-item">
          <div className="settings-item-text">
            <strong>{t("settings.agents.statusHooks.label")}</strong>
            <span className="settings-path">{t("settings.agents.statusHooks.what")}</span>
          </div>
          <button
            type="button"
            role="switch"
            className="agent-switch"
            aria-checked={status?.hooks ?? false}
            aria-label={t("settings.agents.statusHooks.label")}
            disabled={statusBusy || !status}
            data-field="hooks"
            onClick={() => void toggleHooks()}
          />
        </li>
      </ul>
      <p className="settings-empty">{t("settings.agents.statusHooks.hint")}</p>

      <ConfirmDialog
        open={confirmSkip}
        title={t("settings.agents.skipTitle")}
        body={t("settings.agents.skipBody")}
        confirmLabel={t("settings.agents.approvals.skip")}
        onConfirm={() => {
          setConfirmSkip(false);
          void defaults("skip", current.defaultAgent, current.defaultShell);
        }}
        onCancel={() => setConfirmSkip(false)}
      />
    </div>
  );
}
