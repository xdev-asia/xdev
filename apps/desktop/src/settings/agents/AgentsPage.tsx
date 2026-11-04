import { useEffect, useState } from "react";
import type { JSX } from "react";
import {
  toApiError,
  type Account,
  type AgentsSettings,
  type ApiError,
  type Approvals,
  type SwitchRunning,
  type ProfilesView,
  type ProfileView,
  type SessionSearchStatus,
  type StatusSettings,
} from "@/api";
import { useProfiles } from "@/agents/profileStore";
import { patchStatusSettings, setStatusSettings } from "@/status/statusSettings";
import { Button, Disclosure, Switch } from "@xdev-asia/ui";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { SettingGroup, SettingRow } from "@/settings/SettingRow";
import type { SettingsSectionProps } from "@/settings/sections";
import { freeId } from "./agentForm";
import { ProfileEditor } from "./ProfileEditor";
import { ShellsSection } from "./ShellsSection";

const SWITCH_CHOICES: readonly SwitchRunning[] = ["ask", "restart", "keep"];

/** Settings → Agents: the Approvals switch, defaults, agent profiles, shells and Status hooks. */
export function AgentsPage(props: SettingsSectionProps & { onStatusSaved?(settings: StatusSettings): void }): JSX.Element {
  const { api, filter } = props;
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
  // What a switch of the active account does to agent tabs that are running.
  const [switchPolicy, setSwitchPolicy] = useState<AgentsSettings | null>(null);
  // What the conversation index holds; read again whenever the consent or the index may have moved.
  const [searchStatus, setSearchStatus] = useState<SessionSearchStatus | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    api.profiles().then(setView, (e) => setError(toApiError(e).code));
    api.accounts().then((a) => setAccounts(a.accounts), () => setAccounts([]));
    api.statusSettings().then(setStatus, (e) => setError(toApiError(e).code));
    api.agentsSettings().then(setSwitchPolicy, (e) => setError(toApiError(e).code));
    api.sessionSearchStatus().then(setSearchStatus, () => setSearchStatus(null));
  }, [api]);

  // Another window or a file edit can change the policy; follow it.
  useEffect(
    () =>
      api.onSettingsChanged(({ sections }) => {
        if (!sections.includes("agents")) return;
        api.agentsSettings().then(setSwitchPolicy, () => {});
        api.sessionSearchStatus().then(setSearchStatus, () => {});
      }),
    [api],
  );

  async function pickSwitch(next: SwitchRunning): Promise<void> {
    if (!switchPolicy || next === switchPolicy.accountSwitch) return;
    setError(undefined);
    try {
      setSwitchPolicy(await api.agentsSettingsPut({ ...switchPolicy, accountSwitch: next }));
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  async function toggleSearch(on: boolean): Promise<void> {
    if (!switchPolicy) return;
    setError(undefined);
    try {
      setSwitchPolicy(await api.agentsSettingsPut({ ...switchPolicy, sessionSearch: on }));
      setSearchStatus(await api.sessionSearchStatus());
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  async function clearSearch(): Promise<void> {
    setConfirmClear(false);
    try {
      setSwitchPolicy(await api.sessionSearchClear());
      setSearchStatus(await api.sessionSearchStatus());
      pushToast({ id: "session-search-clear", text: t("sessionSearch.cleared") });
    } catch (e) {
      pushToast({ id: "session-search-clear", text: t(`error.${toApiError(e).code}`) });
    }
  }

  // Off, the `.off` marker drops hook events at once and open tabs go back to timing. On, tabs started
  // with hook flags use them again; a tab started while off has none until it restarts.
  async function toggleHooks(): Promise<void> {
    if (statusBusy || !status) return;
    setStatusBusy(true);
    setError(undefined);
    try {
      const stored = await patchStatusSettings(api, { hooks: !status.hooks });
      setStatus(stored);
      (props.onStatusSaved ?? setStatusSettings)(stored);
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

      <SettingRow id="agents.approvals" filter={filter}>
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
      </SettingRow>

      <SettingGroup ids={["agents.defaultAgent", "agents.defaultShell"]} filter={filter}>
      <h4 className="settings-group">{t("settings.agents.defaults")}</h4>
      <div className="ws-fields">
        <SettingRow id="agents.defaultAgent" filter={filter}>
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
        </SettingRow>
        <SettingRow id="agents.defaultShell" filter={filter}>
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
        </SettingRow>
      </div>
      </SettingGroup>

      <SettingRow id="agents.profiles" filter={filter}>
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
      </SettingRow>

      <SettingRow id="agents.shells" filter={filter}>
        <ShellsSection
          shells={current.shells}
          busy={busy}
          onAdd={(s) => void act(() => api.shellPut(s))}
          onRemove={(id) => void act(() => api.shellRemove(id))}
        />
      </SettingRow>

      <SettingRow id="agents.accountSwitch" filter={filter}>
      <h4 className="settings-group">{t("settings.agents.accountSwitch")}</h4>
      <div className="ws-fields">
        <label className="ws-field">
          <span>{t("settings.agents.accountSwitch.label")}</span>
          <select
            value={switchPolicy?.accountSwitch ?? "ask"}
            disabled={!switchPolicy}
            data-field="accountSwitch"
            onChange={(e) => void pickSwitch(e.target.value as SwitchRunning)}
          >
            {SWITCH_CHOICES.map((c) => (
              <option key={c} value={c}>
                {t(`settings.agents.accountSwitch.${c}`)}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings-empty">{t(`settings.agents.accountSwitch.${switchPolicy?.accountSwitch ?? "ask"}Hint`)}</p>
      </SettingRow>

      <SettingRow id="agents.sessionSearch" filter={filter}>
      <h4 className="settings-group">{t("settings.agents.sessionSearch")}</h4>
      <ul className="settings-list" data-section="session-search">
        <li className="settings-item">
          <div className="settings-item-text">
            <strong>{t("settings.agents.sessionSearch.label")}</strong>
            <span className="settings-path">{t("settings.agents.sessionSearch.hint")}</span>
          </div>
          <Switch
            checked={switchPolicy?.sessionSearch ?? false}
            aria-label={t("settings.agents.sessionSearch.label")}
            disabled={!switchPolicy}
            data-field="sessionSearch"
            onChange={(e) => void toggleSearch(e.target.checked)}
          />
        </li>
      </ul>
      {switchPolicy?.sessionSearch && searchStatus && (
        <p className="settings-empty" data-field="sessionSearchStatus">
          {searchStatus.indexing
            ? t("sessionSearch.indexing")
            : t("sessionSearch.status", { sessions: searchStatus.sessions, messages: searchStatus.messages })}
        </p>
      )}
      <Disclosure title={t("sessionSearch.advanced")} defaultExpanded={false}>
        <Button variant="secondary" data-field="sessionSearchClear" onClick={() => setConfirmClear(true)}>
          {t("sessionSearch.clear")}
        </Button>
      </Disclosure>
      </SettingRow>

      <SettingRow id="agents.statusHooks" filter={filter}>
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
      </SettingRow>

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

      <ConfirmDialog
        open={confirmClear}
        title={t("sessionSearch.clear.title")}
        body={t("sessionSearch.clear.body")}
        confirmLabel={t("sessionSearch.clear.confirm")}
        onConfirm={() => void clearSearch()}
        onCancel={() => setConfirmClear(false)}
      />
    </div>
  );
}
