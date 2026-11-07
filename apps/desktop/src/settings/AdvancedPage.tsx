import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, Field, Textarea } from "@xdev-asia/ui";
import { toApiError, type ApiError, type NetworkSettings } from "@/api";
import { useI18n } from "@/i18n";
import { fromDraft, mirrorProblem, proxyProblem, toDraft, type NetworkDraft } from "./advancedNetwork";
import { ConfigIo } from "./ConfigIo";
import { SettingGroup, SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

const IDS = ["advanced.proxy", "advanced.noProxy", "advanced.nodeMirror", "advanced.http1", "advanced.machineName"];
const CONFIG_IDS = ["advanced.export"];
const EMPTY: NetworkDraft = { proxyUrl: "", noProxy: "", nodeMirror: "", machineName: "", http1Only: false };

/** Settings → Advanced: the proxy and its bypass list, the Node mirror and this machine's name. */
export function AdvancedPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t } = useI18n();
  const [saved, setSaved] = useState<NetworkSettings | null>(null);
  const [draft, setDraft] = useState<NetworkDraft>(EMPTY);
  const [hostName, setHostName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  const load = (): void => {
    api.networkSettings().then(
      (s) => {
        setSaved(s);
        setDraft(toDraft(s));
      },
      (e: unknown) => setError(toApiError(e).code),
    );
    api.machineName().then(setHostName, () => {});
  };

  useEffect(load, [api]);

  const proxyIssue = proxyProblem(draft.proxyUrl);
  const mirrorIssue = mirrorProblem(draft.nodeMirror);
  const next = fromDraft(draft);
  const changed = saved !== null && JSON.stringify(next) !== JSON.stringify(saved);

  async function save(): Promise<void> {
    if (!saved || busy || proxyIssue || mirrorIssue) return;
    setBusy(true);
    setError(undefined);
    try {
      const stored = await api.networkSettingsPut(next);
      setSaved(stored);
      setDraft(toDraft(stored));
      api.machineName().then(setHostName, () => {});
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const edit = (change: Partial<NetworkDraft>): void => setDraft({ ...draft, ...change });
  const message = (issue: "scheme" | "invalid" | undefined, kind: "proxy" | "mirror"): string | undefined =>
    issue ? t(`settings.advanced.${kind}.${issue}`) : undefined;

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.advanced.title")}</h3>
        <p>{t("settings.advanced.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <SettingGroup ids={IDS} filter={filter}>
        {saved && (
          <>
            <SettingRow id="advanced.proxy" filter={filter}>
              <Field
                label={t("settings.advanced.proxy")}
                name="proxyUrl"
                value={draft.proxyUrl}
                placeholder="http://127.0.0.1:8080"
                spellCheck={false}
                autoComplete="off"
                hint={t("settings.advanced.proxy.hint")}
                error={message(proxyIssue, "proxy")}
                disabled={busy}
                onChange={(e) => edit({ proxyUrl: e.target.value })}
              />
            </SettingRow>
            <SettingRow id="advanced.noProxy" filter={filter}>
              <Textarea
                label={t("settings.advanced.noProxy")}
                name="noProxy"
                mono
                rows={4}
                value={draft.noProxy}
                placeholder={"localhost\n.example.com"}
                spellCheck={false}
                hint={t("settings.advanced.noProxy.hint")}
                disabled={busy}
                onChange={(e) => edit({ noProxy: e.target.value })}
              />
            </SettingRow>
            <SettingRow id="advanced.nodeMirror" filter={filter}>
              <Field
                label={t("settings.advanced.nodeMirror")}
                name="nodeMirror"
                value={draft.nodeMirror}
                placeholder="https://registry.npmmirror.com"
                spellCheck={false}
                autoComplete="off"
                hint={t("settings.advanced.nodeMirror.hint")}
                error={message(mirrorIssue, "mirror")}
                disabled={busy}
                onChange={(e) => edit({ nodeMirror: e.target.value })}
              />
            </SettingRow>
            <SettingRow id="advanced.http1" filter={filter}>
              <ul className="settings-list">
                <li className="settings-item" data-switch="http1Only">
                  <div className="settings-item-text">
                    <strong>{t("settings.advanced.http1")}</strong>
                    <small className="settings-hint">{t("settings.advanced.http1.hint")}</small>
                  </div>
                  <button
                    type="button"
                    role="switch"
                    className="agent-switch"
                    aria-checked={draft.http1Only}
                    aria-label={t("settings.advanced.http1")}
                    disabled={busy}
                    onClick={() => edit({ http1Only: !draft.http1Only })}
                  />
                </li>
              </ul>
            </SettingRow>
            <SettingRow id="advanced.machineName" filter={filter}>
              <Field
                label={t("settings.advanced.machineName")}
                name="machineName"
                value={draft.machineName}
                placeholder={hostName}
                maxLength={64}
                spellCheck={false}
                autoComplete="off"
                hint={t("settings.advanced.machineName.hint")}
                disabled={busy}
                onChange={(e) => edit({ machineName: e.target.value })}
              />
            </SettingRow>
            <Button variant="primary" type="button" data-act="save-advanced" disabled={busy || !changed || !!proxyIssue || !!mirrorIssue} onClick={() => void save()}>
              {t("settings.advanced.save")}
            </Button>
          </>
        )}
      </SettingGroup>
      <SettingGroup ids={CONFIG_IDS} filter={filter}>
        <h4 className="settings-group">{t("settings.config.title")}</h4>
        <SettingRow id="advanced.export" filter={filter}>
          <ConfigIo api={api} onApplied={load} />
        </SettingRow>
      </SettingGroup>
    </div>
  );
}
