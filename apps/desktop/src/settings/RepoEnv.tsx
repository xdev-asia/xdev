import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type EnvPreviewRow, type RepoView } from "@/api";
import { useI18n } from "@/i18n";
import { envChanged, isBlank, keyProblem, rowsFrom, rowsValid, secretPlan, toPatch, type EnvRow } from "./envRows";

type Props = {
  api: Api;
  repo: RepoView;
  /** The repo as saved, after a save. */
  onSaved(repo: RepoView): void;
};

/**
 * A repo's Environment: key and value rows for the terminals started in it or its worktrees. A secret row's
 * value goes to the keychain, never to the settings; the preview below shows what a terminal gets, secrets masked.
 */
export function RepoEnv({ api, repo, onSaved }: Props): JSX.Element {
  const { t } = useI18n();
  const nextId = useRef(1);
  const fresh = (): number => nextId.current++;
  const [rows, setRows] = useState<EnvRow[]>([]);
  const [preview, setPreview] = useState<EnvPreviewRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();
  const [status, setStatus] = useState("");
  const focusLast = useRef(false);
  const list = useRef<HTMLUListElement>(null);

  async function load(env = repo.env): Promise<void> {
    const [stored, shown] = await Promise.all([api.repoEnvSecrets(repo.id), api.repoEnvPreview(repo.id)]);
    setRows(rowsFrom(env, stored, nextId.current).map((r) => ({ ...r, id: fresh() })));
    setPreview(shown);
  }

  useEffect(() => {
    load().catch((e: unknown) => setError(toApiError(e).code));
  }, [api, repo.id]);

  useEffect(() => {
    if (!focusLast.current) return;
    focusLast.current = false;
    list.current?.querySelector<HTMLInputElement>("li:last-child input[name=envKey]")?.focus();
  }, [rows.length]);

  const edit = (id: number, change: Partial<EnvRow>): void => {
    setStatus("");
    setRows((all) => all.map((r) => (r.id === id ? { ...r, ...change } : r)));
  };
  const kept = rows.filter((r) => !isBlank(r));
  const valid = rowsValid(rows);
  const changed = envChanged(repo.env, rows);

  async function save(): Promise<void> {
    if (busy || !valid) return;
    setBusy(true);
    setError(undefined);
    setStatus("");
    try {
      const plan = secretPlan(repo.env, rows);
      const next = await api.repoUpdate(repo.id, { env: toPatch(rows) });
      for (const key of plan.clear) await api.repoEnvSecretClear(repo.id, key);
      for (const s of plan.set) await api.repoEnvSecretSet(repo.id, s.key, s.value);
      onSaved(next);
      await load(next.env);
      setStatus(t("settings.repos.env.saved"));
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  const problemText = (row: EnvRow): string | undefined => {
    if (isBlank(row)) return undefined;
    const p = keyProblem(row.key, kept, row.id);
    return p ? t(`settings.repos.env.key.${p}`) : undefined;
  };

  return (
    <div className="ws-field" role="group" aria-labelledby={`settings-${repo.id}-env-label`} data-repo-env={repo.id}>
      <span id={`settings-${repo.id}-env-label`}>{t("settings.repos.env")}</span>
      <small className="settings-hint">{t("settings.repos.env.hint")}</small>
      {rows.length === 0 ? (
        <small className="settings-hint">{t("settings.repos.env.none")}</small>
      ) : (
        <ul className="settings-list env-rows" ref={list}>
          {rows.map((row, i) => {
            const problem = problemText(row);
            const n = i + 1;
            return (
              <li key={row.id} className="settings-item env-row" data-env-row={row.key || undefined}>
                <label className="ws-field">
                  <span>{t("settings.repos.env.key")}</span>
                  <input
                    type="text"
                    name="envKey"
                    className="ws-mono"
                    value={row.key}
                    spellCheck={false}
                    autoComplete="off"
                    aria-invalid={problem ? true : undefined}
                    aria-describedby={problem ? `env-${repo.id}-${row.id}-problem` : undefined}
                    disabled={busy}
                    onChange={(e) => edit(row.id, { key: e.target.value })}
                  />
                </label>
                <label className="ws-field">
                  <span>{t("settings.repos.env.value")}</span>
                  <input
                    type={row.secret ? "password" : "text"}
                    name="envValue"
                    className="ws-mono"
                    value={row.value}
                    spellCheck={false}
                    autoComplete="off"
                    placeholder={row.secret && row.stored ? t("settings.repos.env.stored") : undefined}
                    disabled={busy}
                    onChange={(e) => edit(row.id, { value: e.target.value })}
                  />
                </label>
                <label className="ws-tick">
                  <input type="checkbox" name="envSecret" checked={row.secret} disabled={busy} onChange={(e) => edit(row.id, { secret: e.target.checked, value: "" })} />
                  <span className="ws-tick-text">{t("settings.repos.env.secret")}</span>
                </label>
                <button
                  type="button"
                  className="btn-secondary env-remove"
                  disabled={busy}
                  aria-label={t("settings.repos.env.remove", { n: String(n) })}
                  onClick={() => {
                    setStatus("");
                    setRows((all) => all.filter((r) => r.id !== row.id));
                  }}
                >
                  {t("settings.repos.env.removeShort")}
                </button>
                {problem && (
                  <small id={`env-${repo.id}-${row.id}-problem`} className="error-text settings-error env-problem">
                    {problem}
                  </small>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error && (
        <small className="error-text settings-error" role="alert">
          {t(`error.${error}`)}
        </small>
      )}
      <div className="settings-actions settings-actions-start">
        <button
          type="button"
          className="btn-secondary"
          data-env-add
          disabled={busy || rows.length >= 100}
          onClick={() => {
            focusLast.current = true;
            setStatus("");
            setRows((all) => [...all, { id: fresh(), key: "", value: "", secret: false, stored: false }]);
          }}
        >
          {t("settings.repos.env.add")}
        </button>
        <button type="button" className="btn-secondary" data-env-save disabled={busy || !changed || !valid} onClick={() => void save()}>
          {t("settings.repos.env.save")}
        </button>
        <span role="status" className="settings-hint">
          {status}
        </span>
      </div>
      <div role="group" aria-labelledby={`settings-${repo.id}-env-preview`}>
        <span id={`settings-${repo.id}-env-preview`}>{t("settings.repos.env.preview")}</span>
        {preview.length === 0 ? (
          <small className="settings-hint">{t("settings.repos.env.preview.none")}</small>
        ) : (
          <ul className="env-preview ws-mono" data-env-preview>
            {preview.map((p) => (
              <li key={p.key}>
                <span>{p.key}</span>={p.value}
                {p.overrides && <small className="settings-hint"> {t("settings.repos.env.overrides")}</small>}
              </li>
            ))}
          </ul>
        )}
        <small className="settings-hint">{t("settings.repos.env.preview.hint")}</small>
      </div>
    </div>
  );
}
