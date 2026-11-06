import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, Disclosure, StatusDot } from "@xdev-asia/ui";
import type { StatusTone } from "@xdev-asia/ui";
import { toApiError, type Api, type Cli, type CliHooks } from "@/api";
import { useI18n } from "@/i18n";

/** The dot of a row: installed is ok, an old install or a file xDev cannot read wants a look. */
function tone(row: CliHooks): StatusTone {
  if (row.support.kind === "launch") return "ok";
  if (row.error) return "danger";
  if (row.state === "installed") return "ok";
  if (row.state === "outdated") return "warn";
  return "neutral";
}

/**
 * Settings → Agents → Status hooks: how each catalogue CLI gets xDev's hooks. A CLI that reads hooks only
 * from its own config (managed) can have them installed, updated or removed here; one without a confirmed
 * mechanism is listed with its reason. `nameOf` gives a CLI's display name.
 */
export function HookInstallSection({ api, nameOf }: { api: Api; nameOf(cli: Cli): string }): JSX.Element {
  const { t } = useI18n();
  const [rows, setRows] = useState<CliHooks[] | null>(null);
  const [busy, setBusy] = useState<Cli | null>(null);
  // The code of the last failed install or removal, per CLI, until the next try.
  const [failed, setFailed] = useState<Partial<Record<Cli, string>>>({});

  useEffect(() => {
    api.hookInstalls().then(setRows, () => setRows([]));
  }, [api]);

  async function act(row: CliHooks, remove: boolean): Promise<void> {
    setBusy(row.cli);
    setFailed((f) => ({ ...f, [row.cli]: undefined }));
    try {
      const next = remove ? await api.hookUninstall(row.cli) : await api.hookInstall(row.cli);
      setRows((all) => all?.map((r) => (r.cli === next.cli ? next : r)) ?? all);
    } catch (e) {
      setFailed((f) => ({ ...f, [row.cli]: toApiError(e).code }));
    } finally {
      setBusy(null);
    }
  }

  if (rows === null) return <p className="settings-empty">{t("settings.agents.hookInstall.loading")}</p>;
  const usable = rows.filter((r) => r.support.kind !== "unsupported");
  const unsupported = rows.filter((r) => r.support.kind === "unsupported");

  const stateText = (row: CliHooks): string => {
    if (row.support.kind === "launch") return t("settings.agents.hookInstall.launch");
    const code = failed[row.cli] ?? row.error;
    if (code) return t(`settings.agents.hookInstall.error.${code}`);
    return t(`settings.agents.hookInstall.${row.state ?? "missing"}`);
  };

  const action = (row: CliHooks): JSX.Element | null => {
    if (row.support.kind !== "managed" || row.error === "hooks-no-home") return null;
    const remove = row.state === "installed";
    const label = remove ? "remove" : row.state === "outdated" ? "update" : "install";
    return (
      <Button
        type="button"
        variant="secondary"
        data-field={`hookInstall-${label}`}
        disabled={busy !== null}
        aria-label={t(`settings.agents.hookInstall.${label}.for`, { name: nameOf(row.cli) })}
        onClick={() => void act(row, remove)}
      >
        {t(`settings.agents.hookInstall.${label}`)}
      </Button>
    );
  };

  return (
    <div data-section="hook-install">
      <p className="settings-empty">{t("settings.agents.hookInstall.what")}</p>
      <ul className="settings-list">
        {usable.map((row) => (
          <li key={row.cli} className="settings-item" data-cli={row.cli} data-state={row.state ?? row.support.kind}>
            <div className="settings-item-text">
              <StatusDot tone={tone(row)} label={nameOf(row.cli)} />
              <span className="settings-path">{stateText(row)}</span>
              {row.settings && <span className="ws-mono settings-path">{row.settings}</span>}
            </div>
            <div className="settings-actions">{action(row)}</div>
          </li>
        ))}
      </ul>
      {unsupported.length > 0 && (
        <Disclosure title={t("settings.agents.hookInstall.unsupported")} count={unsupported.length} defaultExpanded={false}>
          <ul className="settings-list" data-field="hookInstall-unsupported">
            {unsupported.map((row) => (
              <li key={row.cli} className="settings-item" data-cli={row.cli}>
                <div className="settings-item-text">
                  <strong>{nameOf(row.cli)}</strong>
                  {row.support.kind === "unsupported" && <span className="settings-path">{t(`settings.agents.hookInstall.reason.${row.support.reason}`)}</span>}
                </div>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </div>
  );
}
