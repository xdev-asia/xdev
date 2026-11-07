import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, EmptyState, Field, FormSection, Select, Switch } from "@xdev-asia/ui";
import { toApiError, type Api, type HostScopeEntry, type HostSettingsView } from "@/api";
import { useI18n } from "@/i18n";
import { badEnvRows, changedKeys, daysOk, fromForm, MAX_ENV, patch, toForm, type HostForm } from "./hosts/hostModel";
import { SettingGroup, SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";
import { useSaveBar } from "./useSaveBar";

export const LOCAL_SCOPE = "local";
const HOST_ERRORS: ReadonlySet<string> = new Set(["bad_name", "bad_path", "bad_env", "bad_arg", "not_found"]);
const IDS = ["hosts.scope", "hosts.label", "hosts.shell", "hosts.env", "hosts.history", "hosts.historyDays"];

/** Saves the form: one put, carrying only the keys that changed. Resolves with the stored view. */
export async function saveHost(api: Api, view: HostSettingsView, form: HostForm): Promise<HostSettingsView> {
  const next = fromForm(form);
  const keys = changedKeys(view.stored, next);
  if (keys.length === 0) return view;
  return api.hostSettingsPut(view.hostId, patch(view.stored, next, keys));
}

/** The field a store error belongs under, given which keys the save changed. */
export function errorField(code: string, form: HostForm, view: HostSettingsView): "label" | "shell" | "claudeHome" | "env" | "days" | null {
  if (code === "bad_name") return "label";
  if (code === "bad_env") return "env";
  if (code === "bad_arg") return "days";
  if (code === "bad_path") {
    const before = toForm(view.stored);
    return form.shell !== before.shell ? "shell" : "claudeHome";
  }
  return null;
}

export interface HostsPanelProps {
  entries: readonly HostScopeEntry[];
  hostId: string;
  view: HostSettingsView | null;
  form: HostForm | null;
  busy: boolean;
  /** An error code from the last save, and the field it is shown under. */
  error?: { code: string; field: ReturnType<typeof errorField> };
  filter?: SettingsSectionProps["filter"];
  onPick(hostId: string): void;
  onForm(form: HostForm): void;
  onSave(): void;
  /** The view's SaveBar saves and discards, so the panel draws no Save button of its own. */
  barTakesSave?: boolean;
  onOpenSsh(): void;
  onOpenSection(id: string): void;
}

/** The pieces of the page, without state, so a test can render each state. */
export function HostsPanel(props: HostsPanelProps): JSX.Element {
  const { t } = useI18n();
  const { filter, form, view, error } = props;
  const text = (code: string) => (HOST_ERRORS.has(code) ? t(`settings.hosts.error.${code}`) : t(`error.${code}`));
  const msg = (field: NonNullable<HostsPanelProps["error"]>["field"]) => (error && error.field === field ? text(error.code) : undefined);
  const hosts = props.entries.filter((e) => e.id !== LOCAL_SCOPE);

  if (hosts.length === 0) {
    return (
      <div className="settings-page">
        <div className="settings-head">
          <h3>{t("settings.hosts.title")}</h3>
          <p>{t("settings.hosts.hint")}</p>
        </div>
        <EmptyState
          title={t("settings.hosts.empty")}
          hint={t("settings.hosts.emptyHint")}
          actions={
            <Button variant="primary" type="button" onClick={props.onOpenSsh}>
              {t("settings.hosts.addHost")}
            </Button>
          }
        />
      </div>
    );
  }

  const options = props.entries.map((e) => ({
    value: e.id,
    label: e.id === LOCAL_SCOPE ? t("settings.hosts.local") : e.overrides > 0 ? t("settings.hosts.pickerOverrides", { label: e.label, count: e.overrides }) : e.label,
  }));
  const local = props.hostId === LOCAL_SCOPE;
  const set = (patchForm: Partial<HostForm>) => form && props.onForm({ ...form, ...patchForm });
  const envBad = form ? badEnvRows(form.env) : [];
  const daysBad = form ? !daysOk(form.days) : false;
  const dirty = !!(form && view && changedKeys(view.stored, fromForm(form)).length > 0);
  const eff = view?.effective;

  return (
    <div className="settings-page host-settings">
      <div className="settings-head">
        <h3>{t("settings.hosts.title")}</h3>
        <p>{t("settings.hosts.hint")}</p>
      </div>
      <SettingRow id="hosts.scope" filter={filter}>
        <Select id="host-scope" aria-label={t("settings.hosts.scope")} options={options} value={props.hostId} onChange={(e) => props.onPick(e.target.value)} />
      </SettingRow>
      {local && (
        <div className="host-links" data-testid="host-local">
          <p className="settings-hint">{t("settings.hosts.localHint")}</p>
          <Button type="button" variant="secondary" onClick={() => props.onOpenSection("terminal")}>
            {t("settings.hosts.openTerminal")}
          </Button>
          <Button type="button" variant="secondary" onClick={() => props.onOpenSection("agents")}>
            {t("settings.hosts.openAgents")}
          </Button>
        </div>
      )}
      {!local && form && view && eff && (
        <form
          className="host-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (dirty && !props.busy && envBad.length === 0 && !daysBad) props.onSave();
          }}
        >
          <SettingGroup ids={IDS.slice(1, 4)} filter={filter}>
            <FormSection title={t("settings.hosts.general")}>
              <SettingRow id="hosts.label" filter={filter}>
                <Field
                  label={t("settings.hosts.label")}
                  name="label"
                  value={form.label}
                  placeholder={eff.label}
                  maxLength={64}
                  hint={t("settings.hosts.labelHint")}
                  error={msg("label")}
                  disabled={props.busy}
                  onChange={(e) => set({ label: e.target.value })}
                />
              </SettingRow>
              <SettingRow id="hosts.shell" filter={filter}>
                <Field
                  label={t("settings.hosts.shell")}
                  name="shell"
                  value={form.shell}
                  placeholder="/bin/bash"
                  spellCheck={false}
                  autoComplete="off"
                  hint={t("settings.hosts.shellHint")}
                  error={msg("shell")}
                  disabled={props.busy}
                  onChange={(e) => set({ shell: e.target.value })}
                />
                {form.shell !== "" && (
                  <Button type="button" variant="link" onClick={() => set({ shell: "" })}>
                    {t("settings.hosts.useDefault")}
                  </Button>
                )}
              </SettingRow>
              <SettingRow id="hosts.env" filter={filter}>
                <div className="host-env" role="group" aria-label={t("settings.hosts.env")}>
                  <strong>{t("settings.hosts.env")}</strong>
                  <small className="settings-hint">{t("settings.hosts.envHint")}</small>
                  {form.env.map((v, i) => (
                    <div className="host-env-row" key={i}>
                      <Field
                        label={t("settings.hosts.envName")}
                        name={`env-name-${i}`}
                        value={v.name}
                        spellCheck={false}
                        autoComplete="off"
                        error={envBad.includes(i) ? t("settings.hosts.error.bad_env") : undefined}
                        disabled={props.busy}
                        onChange={(e) => set({ env: form.env.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })}
                      />
                      <Field
                        label={t("settings.hosts.envValue")}
                        name={`env-value-${i}`}
                        value={v.value}
                        spellCheck={false}
                        autoComplete="off"
                        disabled={props.busy}
                        onChange={(e) => set({ env: form.env.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })}
                      />
                      <Button type="button" variant="ghost" onClick={() => set({ env: form.env.filter((_, j) => j !== i) })}>
                        {t("settings.hosts.envRemove")}
                      </Button>
                    </div>
                  ))}
                  {msg("env") && <p className="error-text" role="alert">{msg("env")}</p>}
                  <Button type="button" variant="secondary" disabled={props.busy || form.env.length >= MAX_ENV} onClick={() => set({ env: [...form.env, { name: "", value: "" }] })}>
                    {t("settings.hosts.envAdd")}
                  </Button>
                </div>
              </SettingRow>
            </FormSection>
          </SettingGroup>
          <SettingGroup ids={IDS.slice(4)} filter={filter}>
            <FormSection title={t("settings.hosts.historySection")} description={t("settings.hosts.historyHint")}>
              <SettingRow id="hosts.history" filter={filter}>
                <div className="host-history">
                  <Switch
                    aria-label={t("settings.hosts.history")}
                    label={t("settings.hosts.history")}
                    checked={form.history === "default" ? eff.history.enabled : form.history === "on"}
                    disabled={props.busy}
                    onChange={() => {
                      const on = form.history === "default" ? eff.history.enabled : form.history === "on";
                      set({ history: on ? "off" : "on" });
                    }}
                  />
                  {form.history !== "default" && (
                    <Button type="button" variant="link" onClick={() => set({ history: "default" })}>
                      {t("settings.hosts.useDefault")}
                    </Button>
                  )}
                </div>
                <Field
                  label={t("settings.hosts.claudeHome")}
                  name="claudeHome"
                  value={form.claudeHome}
                  placeholder={eff.history.claudeHome}
                  spellCheck={false}
                  autoComplete="off"
                  error={msg("claudeHome")}
                  disabled={props.busy}
                  onChange={(e) => set({ claudeHome: e.target.value })}
                />
                <Field
                  label={t("settings.hosts.codexHome")}
                  name="codexHome"
                  value={form.codexHome}
                  placeholder={eff.history.codexHome}
                  spellCheck={false}
                  autoComplete="off"
                  disabled={props.busy}
                  onChange={(e) => set({ codexHome: e.target.value })}
                />
              </SettingRow>
              <SettingRow id="hosts.historyDays" filter={filter}>
                <Field
                  label={t("settings.hosts.days")}
                  name="days"
                  inputMode="numeric"
                  value={form.days}
                  placeholder={String(eff.history.days)}
                  hint={t("settings.hosts.daysHint")}
                  error={daysBad ? t("settings.hosts.error.bad_arg") : msg("days")}
                  disabled={props.busy}
                  onChange={(e) => set({ days: e.target.value })}
                />
              </SettingRow>
            </FormSection>
          </SettingGroup>
          {error && error.field === null && <p className="error-text" role="alert">{text(error.code)}</p>}
          {!props.barTakesSave && (
            <div className="host-actions">
              <Button variant="primary" type="submit" disabled={!dirty || props.busy || envBad.length > 0 || daysBad}>
                {t("settings.hosts.save")}
              </Button>
            </div>
          )}
        </form>
      )}
    </div>
  );
}

/** Settings → Hosts: one SSH host's label, shell, environment and session history. */
export function HostsPage(props: SettingsSectionProps): JSX.Element {
  const { api, arg, filter } = props;
  const [entries, setEntries] = useState<readonly HostScopeEntry[] | null>(null);
  const [hostId, setHostId] = useState(arg && arg !== "" ? arg : LOCAL_SCOPE);
  const [view, setView] = useState<HostSettingsView | null>(null);
  const [form, setForm] = useState<HostForm | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<HostsPanelProps["error"]>();

  const loadEntries = useCallback(() => api.hostScopesList().then(setEntries, () => setEntries([])), [api]);
  useEffect(() => {
    void loadEntries();
  }, [loadEntries]);

  // An arg for a host that is gone falls back to Local.
  useEffect(() => {
    if (entries && !entries.some((e) => e.id === hostId)) setHostId(LOCAL_SCOPE);
  }, [entries, hostId]);

  useEffect(() => {
    setError(undefined);
    if (hostId === LOCAL_SCOPE) {
      setView(null);
      setForm(null);
      return;
    }
    let live = true;
    api.hostSettingsGet(hostId).then(
      (v) => {
        if (!live) return;
        setView(v);
        setForm(toForm(v.stored));
      },
      (e: unknown) => live && setError({ code: toApiError(e).code, field: null }),
    );
    return () => {
      live = false;
    };
  }, [api, hostId]);

  async function save(): Promise<void> {
    if (!view || !form) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await saveHost(api, view, form);
      setView(next);
      setForm(toForm(next.stored));
      props.onChanged();
      void loadEntries();
    } catch (e) {
      const code = toApiError(e).code;
      setError({ code, field: errorField(code, form, view) });
    } finally {
      setBusy(false);
    }
  }

  const dirty = !!(form && view && changedKeys(view.stored, fromForm(form)).length > 0);
  const barTakesSave = useSaveBar(props, {
    dirty,
    busy,
    saveDisabled: !!form && (badEnvRows(form.env).length > 0 || !daysOk(form.days)),
    onSave: () => void save(),
    onDiscard: () => view && setForm(toForm(view.stored)),
  });

  if (entries === null) return <div className="settings-page" aria-busy="true" />;
  return (
    <HostsPanel
      entries={entries}
      hostId={hostId}
      view={view}
      form={form}
      busy={busy}
      error={error}
      filter={filter}
      onPick={setHostId}
      onForm={setForm}
      onSave={() => void save()}
      barTakesSave={barTakesSave}
      onOpenSsh={() => props.openSection?.("ssh")}
      onOpenSection={(id) => props.openSection?.(id)}
    />
  );
}
