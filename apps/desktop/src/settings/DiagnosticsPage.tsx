import { Button } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { openCrashDialog } from "@/crash/crashEvents";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** The default file name of an export: `xdev-diagnostics-YYYYMMDD-HHMMSS.ndjson`, local time. */
export function diagnosticsFileName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `xdev-diagnostics-${day}-${time}.ndjson`;
}

/**
 * Asks Rust to open the save dialog and write the redacted bundle, then says so in a toast. Cancel
 * does nothing; a failure is an error toast. Never throws.
 */
export async function exportDiagnostics(
  api: Pick<Api, "diagnosticsExport" | "diagnosticsRevealExport">,
  t: T,
  now: Date = new Date(),
): Promise<void> {
  try {
    const saved = await api.diagnosticsExport(diagnosticsFileName(now));
    if (!saved) return;
    pushToast({
      text: t("diagnostics.export.done", { path: saved.path, kb: Math.max(1, Math.round(saved.bytes / 1024)) }),
      actions: [{ label: t("diagnostics.export.reveal"), run: () => void api.diagnosticsRevealExport(saved.path).catch(() => {}) }],
    });
  } catch {
    pushToast({ text: t("diagnostics.export.failed") });
  }
}

export function DiagnosticsPage(props: SettingsSectionProps): JSX.Element {
  const { t } = useI18n();
  const { api } = props;
  const [busy, setBusy] = useState(false);

  const run = async () => {
    setBusy(true);
    try {
      await exportDiagnostics(api, t);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-page diagnostics-page">
      <header className="settings-head">
        <h3>{t("settings.diagnostics.title")}</h3>
        <p>{t("settings.diagnostics.lead")}</p>
      </header>

      <SettingRow id="diagnostics.export" filter={props.filter}>
        <div className="diagnostics-row">
          <div className="diagnostics-text">
            <strong>{t("diagnostics.export.title")}</strong>
            <span>{t("diagnostics.export.body")}</span>
          </div>
          <Button variant="primary" type="button" disabled={busy} onClick={() => void run()}>
            {t("diagnostics.export.button")}
          </Button>
        </div>
      </SettingRow>

      <SettingRow id="diagnostics.logs" filter={props.filter}>
        <div className="diagnostics-row">
          <div className="diagnostics-text">
            <strong>{t("diagnostics.logs.title")}</strong>
            <span>{t("diagnostics.logs.body")}</span>
          </div>
          <Button variant="secondary" type="button" onClick={() => void api.diagnosticsRevealLogs().catch(() => {})}>
            {t("diagnostics.logs.button")}
          </Button>
        </div>
      </SettingRow>

      <SettingRow id="diagnostics.crash" filter={props.filter}>
        <div className="diagnostics-row">
          <div className="diagnostics-text">
            <strong>{t("diagnostics.crash.title")}</strong>
            <span>{t("diagnostics.crash.body")}</span>
          </div>
          <Button variant="secondary" type="button" onClick={() => openCrashDialog({ latest: true })}>
            {t("diagnostics.crash.button")}
          </Button>
        </div>
      </SettingRow>
    </div>
  );
}
