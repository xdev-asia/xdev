import { Badge, Banner, Button, Field } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { AI_KEY_PROVIDERS, toApiError, type AiKeyProvider, type Api } from "@/api";
import { useI18n } from "@/i18n";
import { SettingGroup, SettingRow } from "./SettingRow";
import type { SettingsFilter } from "./sections";

const IDS = ["usage.apiKeys"];

type Saved = Partial<Record<AiKeyProvider, boolean>>;
type Texts = Partial<Record<AiKeyProvider, string>>;

/**
 * One row per provider: a Saved / Not saved badge, a password field, Save and Remove. The key goes
 * to the system keychain through the backend and never comes back; only `saved` does. The list is
 * read once on mount.
 */
export function ApiKeysSection(props: { api: Api; filter?: SettingsFilter }): JSX.Element | null {
  const { api, filter } = props;
  const { t } = useI18n();
  const [saved, setSaved] = useState<Saved>({});
  const [drafts, setDrafts] = useState<Texts>({});
  const [errors, setErrors] = useState<Texts>({});
  const [busy, setBusy] = useState<Partial<Record<AiKeyProvider, boolean>>>({});
  const [status, setStatus] = useState("");
  const [keychain, setKeychain] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .aiKeys()
      .then((rows) => {
        if (live) setSaved(Object.fromEntries(rows.map((r) => [r.provider, r.saved])));
      })
      .catch((e) => {
        if (live && toApiError(e).code === "secret_store") setKeychain(true);
      });
    return () => {
      live = false;
      setDrafts({});
    };
  }, [api]);

  function fail(provider: AiKeyProvider, e: unknown): void {
    const code = toApiError(e).code;
    setStatus("");
    if (code === "secret_store") {
      setKeychain(true);
      return;
    }
    setErrors((prev) => ({ ...prev, [provider]: code === "too_large" ? t("settings.usage.apiKeys.tooLong") : t(`error.${code}`) }));
  }

  async function run(provider: AiKeyProvider, work: () => Promise<void>): Promise<void> {
    setBusy((prev) => ({ ...prev, [provider]: true }));
    setErrors((prev) => ({ ...prev, [provider]: undefined }));
    try {
      await work();
    } catch (e) {
      fail(provider, e);
    } finally {
      setBusy((prev) => ({ ...prev, [provider]: false }));
    }
  }

  const save = (provider: AiKeyProvider): Promise<void> =>
    run(provider, async () => {
      await api.aiKeySet(provider, drafts[provider] ?? "");
      setDrafts((prev) => ({ ...prev, [provider]: "" }));
      setSaved((prev) => ({ ...prev, [provider]: true }));
      setKeychain(false);
      setStatus(t("settings.usage.apiKeys.didSave"));
    });

  const remove = (provider: AiKeyProvider): Promise<void> =>
    run(provider, async () => {
      await api.aiKeyRemove(provider);
      setSaved((prev) => ({ ...prev, [provider]: false }));
      setKeychain(false);
      setStatus(t("settings.usage.apiKeys.didRemove"));
    });

  return (
    <SettingGroup ids={IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.usage.apiKeys.group")}</h4>
      <SettingRow id="usage.apiKeys" filter={filter}>
        <p className="settings-hint">{t("settings.usage.apiKeys.hint")}</p>
        {keychain && <Banner title={t("error.secret_store")} />}
        <ul className="settings-list">
          {AI_KEY_PROVIDERS.map((provider) => {
            const name = t(`settings.usage.apiKeys.provider.${provider}`);
            const isSaved = saved[provider] === true;
            const draft = drafts[provider] ?? "";
            return (
              <li className="settings-item api-key-row" key={provider} data-ai-key={provider}>
                <div className="settings-item-text">
                  <strong>{name}</strong>
                  <Badge status={isSaved ? "new" : "neutral"}>{t(isSaved ? "settings.usage.apiKeys.saved" : "settings.usage.apiKeys.notSaved")}</Badge>
                </div>
                <Field
                  label={t("settings.usage.apiKeys.field", { provider: name })}
                  type="password"
                  data-field={`key-${provider}`}
                  value={draft}
                  placeholder={t(isSaved ? "settings.usage.apiKeys.replacePlaceholder" : "settings.usage.apiKeys.placeholder")}
                  error={errors[provider]}
                  autoComplete="off"
                  spellCheck={false}
                  onChange={(e) => setDrafts((prev) => ({ ...prev, [provider]: e.target.value }))}
                />
                <div className="settings-actions settings-actions-start">
                  <Button type="button" variant="secondary" data-act={`save-${provider}`} disabled={busy[provider] === true || draft.trim() === ""} onClick={() => void save(provider)}>
                    {t("settings.usage.apiKeys.save")}
                  </Button>
                  <Button type="button" variant="secondary" data-act={`remove-${provider}`} disabled={busy[provider] === true || (!isSaved && !keychain)} onClick={() => void remove(provider)}>
                    {t("settings.usage.apiKeys.remove")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <p role="status" className="settings-hint" data-field="api-keys-status">{status}</p>
      </SettingRow>
    </SettingGroup>
  );
}
