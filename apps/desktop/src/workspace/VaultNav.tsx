import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type VaultView } from "../api";
import { useI18n } from "../i18n";

/** The registered vaults under the Docs & SDLC item; a click opens one. */
export function VaultNav(props: {
  api: Api;
  onOpened(path: string): void;
  // False while the open doc has unsaved edits: its autosave would write into whichever vault is open by then.
  canOpen?(): boolean;
}): JSX.Element | null {
  const { api } = props;
  const { t } = useI18n();
  const [vaults, setVaults] = useState<VaultView[]>([]);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<ApiError["code"] | "unsaved">();

  useEffect(() => {
    api.vaultList().then(setVaults, () => setVaults([]));
    api.lastVault().then(setCurrent, () => setCurrent(null));
  }, [api]);

  async function open(vault: VaultView): Promise<void> {
    setError(undefined);
    if (props.canOpen && !props.canOpen()) {
      setError("unsaved");
      return;
    }
    try {
      await api.openVault(vault.path);
      setCurrent(vault.path);
      props.onOpened(vault.path);
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  // A repo with no docs folder has nothing to open; Settings offers to create one.
  const shown = vaults.filter((v) => v.exists || v.kind === "shared");
  if (shown.length === 0) return null;
  return (
    <div className="ws-vaults">
      <ul className="ws-vault-list" aria-label={t("workspace.vaults.label")}>
        {shown.map((v) => (
          <li key={v.id}>
            <button
              type="button"
              className="ws-vault"
              data-path={v.path}
              data-kind={v.kind}
              disabled={!v.exists}
              title={v.exists ? v.path : t("workspace.vaults.missing", { path: v.path })}
              aria-current={v.path === current ? "true" : undefined}
              onClick={() => void open(v)}
            >
              <span className="ws-vault-name">{v.name}</span>
              {v.kind === "shared" && <span className="ws-tag">{t("workspace.vaults.shared")}</span>}
            </button>
          </li>
        ))}
      </ul>
      {error && (
        <p className="error-text ws-notice" role="alert">
          {error === "unsaved" ? t("workspace.vaults.unsaved") : t(`error.${error}`)}
        </p>
      )}
    </div>
  );
}
