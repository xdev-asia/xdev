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

/** The default file name of an export, stamped with the day. */
export function diagnosticsFileName(now: Date = new Date()): string {
  return `xdev-diagnostics-${now.toISOString().slice(0, 10)}.json`;
}

/**
 * Asks where to save, writes the redacted bundle and says so in a toast. Cancel does nothing; a
 * failure is an error toast. Never throws.
 */
export async function exportDiagnostics(
  api: Pick<Api, "diagnosticsExport" | "diagnosticsRevealLogs">,
  pick: () => Promise<string | null>,
  t: T,
): Promise<void> {
  try {
    const path = await pick();
    if (!path) return;
    const bytes = await api.diagnosticsExport(path);
    pushToast({
      text: t("diagnostics.export.done", { path, kb: Math.max(1, Math.round(bytes / 1024)) }),
      actions: [{ label: t("diagnostics.export.reveal"), run: () => void api.diagnosticsRevealLogs().catch(() => {}) }],
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
      await exportDiagnostics(api, () => api.pickDiagnosticsPath(diagnosticsFileName()), t);
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
          <Button type="button" disabled={busy} onClick={() => void run()}>
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
