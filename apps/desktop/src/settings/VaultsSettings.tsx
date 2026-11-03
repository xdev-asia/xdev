import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type VaultView } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import type { SettingsSectionProps } from "./sections";

/** Repo vaults (each repo's `docs/`) and shared vaults; forgetting one keeps its folder. */
export function VaultsSettings(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [vaults, setVaults] = useState<VaultView[] | null>(null);
  const [error, setError] = useState<ApiError["code"]>();
  const [busy, setBusy] = useState(false);
  const [forgetting, setForgetting] = useState<VaultView | null>(null);

  async function load(): Promise<void> {
    try {
      setVaults(await api.vaultList());
    } catch (e) {
      setError(toApiError(e).code);
      setVaults((v) => v ?? []);
    }
  }

  useEffect(() => {
    void load();
  }, [api]);

  // Every change reloads the list, so a row shows what Rust stored.
  async function act(run: () => Promise<unknown>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await run();
      await load();
      props.onChanged();
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  async function add(): Promise<void> {
    const path = await api.pickFolder().catch(() => null);
    if (path) await act(() => api.vaultAdd(path));
  }

  function createDocs(vault: VaultView): void {
    if (vault.repoId === null) return;
    const repoId = vault.repoId;
    void act(() => api.vaultCreateDocs(repoId, t("vault.starter.file"), t("vault.starter.content")));
  }

  function forget(): void {
    const vault = forgetting;
    setForgetting(null);
    if (vault) void act(() => api.vaultForget(vault.id));
  }

  const repoVaults = vaults?.filter((v) => v.kind === "repo") ?? [];
  const shared = vaults?.filter((v) => v.kind === "shared") ?? [];

  return (
    <div className="settings-page">
      <header className="settings-head">
        <h3>{t("settings.vaults.title")}</h3>
        <p>{t("settings.vaults.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}

      <h4 className="settings-group">{t("settings.vaults.repo")}</h4>
      {vaults && repoVaults.length === 0 && <p className="settings-empty">{t("settings.vaults.noRepos")}</p>}
      <ul className="settings-list">
        {repoVaults.map((v) => (
          <li key={v.id} className="settings-item" data-kind="repo">
            <div className="settings-item-text">
              <strong>{v.name}</strong>
              <span className="ws-mono settings-path">{v.path}</span>
            </div>
            {!v.exists && (
              <button type="button" className="btn-secondary" disabled={busy} onClick={() => createDocs(v)}>
                {t("settings.vaults.create")}
              </button>
            )}
          </li>
        ))}
      </ul>

      <h4 className="settings-group">{t("settings.vaults.shared")}</h4>
      {vaults && shared.length === 0 && <p className="settings-empty">{t("settings.vaults.noShared")}</p>}
      <ul className="settings-list">
        {shared.map((v) => (
          <li key={v.id} className="settings-item" data-kind="shared">
            <div className="settings-item-text">
              <strong>{v.name}</strong>
              <span className="ws-mono settings-path">{v.path}</span>
              {!v.exists && <span className="settings-tag">{t("settings.vaults.missing")}</span>}
            </div>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setForgetting(v)}>
              {t("settings.vaults.forget")}
            </button>
          </li>
        ))}
      </ul>
      <div className="settings-actions settings-actions-start">
        <Button type="button" disabled={busy} onClick={() => void add()}>
          {t("settings.vaults.add")}
        </Button>
      </div>

      <ConfirmDialog
        open={forgetting !== null}
        title={t("settings.vaults.forgetTitle")}
        body={t("settings.vaults.forgetBody", { path: forgetting?.path ?? "" })}
        confirmLabel={t("settings.vaults.forget")}
        onConfirm={forget}
        onCancel={() => setForgetting(null)}
      />
    </div>
  );
}
