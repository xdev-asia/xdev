import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type WorktreeUsage } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { afterClean, cleanTargets, formatSize, heavyTotal, shortPath } from "./diskRows";

/**
 * Disk usage of every worktree and its build folders. Analyze reads the sizes in the background and
 * can be stopped; Delete build folders asks first and removes only the folders it lists.
 */
export function DiskUsage(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [rows, setRows] = useState<WorktreeUsage[] | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<ApiError["code"] | null>(null);
  const [asking, setAsking] = useState<WorktreeUsage | null>(null);
  const [cleaning, setCleaning] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      void api.diskUsageCancel().catch(() => {});
    };
  }, [api]);

  async function analyze(): Promise<void> {
    setScanning(true);
    setError(null);
    try {
      const next = await api.diskUsageScan();
      if (alive.current) setRows(next);
    } catch (e) {
      const code = toApiError(e).code;
      // A stopped scan is not a failure.
      if (alive.current && code !== "cancelled") setError(code);
    } finally {
      if (alive.current) setScanning(false);
    }
  }

  async function clean(row: WorktreeUsage): Promise<void> {
    setCleaning(true);
    setError(null);
    try {
      await api.diskUsageClean(cleanTargets(row));
      if (alive.current) {
        setRows((list) => (list ? afterClean(list, row.worktree) : list));
        setAsking(null);
      }
    } catch (e) {
      if (alive.current) {
        setError(toApiError(e).code);
        setAsking(null);
      }
    } finally {
      if (alive.current) setCleaning(false);
    }
  }

  return (
    <div className="settings-disk">
      <p className="settings-hint">{t("settings.repos.disk.hint")}</p>
      <div className="settings-actions">
        {scanning && (
          <button type="button" className="btn-secondary" data-disk-cancel="" onClick={() => void api.diskUsageCancel()}>
            {t("settings.repos.disk.stop")}
          </button>
        )}
        <Button type="button" data-disk-analyze="" disabled={scanning} onClick={() => void analyze()}>
          {scanning ? t("settings.repos.disk.analyzing") : t("settings.repos.disk.analyze")}
        </Button>
      </div>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {rows && rows.length === 0 && <p className="settings-empty">{t("settings.repos.disk.empty")}</p>}
      {rows && rows.length > 0 && (
        <ul className="settings-disk-rows">
          {rows.map((row) => (
            <li key={row.worktree} className="settings-disk-row" data-worktree={row.worktree}>
              <div className="settings-disk-head">
                <span className="ws-mono" title={row.worktree}>
                  {shortPath(row.worktree)}
                </span>
                <span className="settings-disk-size">{formatSize(row.total)}</span>
              </div>
              {row.heavy.length > 0 && (
                <ul className="settings-disk-heavy">
                  {row.heavy.map((h) => (
                    <li key={h.path}>
                      <span className="ws-mono" title={h.path}>
                        {h.path.slice(row.worktree.length + 1)}
                      </span>
                      <span className="settings-disk-size">{formatSize(h.size)}</span>
                    </li>
                  ))}
                </ul>
              )}
              <div className="settings-actions">
                <button
                  type="button"
                  className="btn-secondary"
                  data-disk-open=""
                  onClick={() => void api.openIn(row.worktree, { type: "fileManager" }).catch((e: unknown) => setError(toApiError(e).code))}
                >
                  {t("settings.repos.disk.open")}
                </button>
                <button type="button" className="btn-secondary" data-disk-delete="" disabled={row.heavy.length === 0 || cleaning} onClick={() => setAsking(row)}>
                  {t("settings.repos.disk.delete")}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {asking && (
        <ConfirmDialog
          open
          titleId="disk-clean-title"
          title={t("settings.repos.disk.confirmTitle", { name: shortPath(asking.worktree) })}
          body={t("settings.repos.disk.confirmBody", { size: formatSize(heavyTotal(asking)) })}
          confirmLabel={cleaning ? t("settings.repos.disk.deleting") : t("settings.repos.disk.delete")}
          onConfirm={() => void clean(asking)}
          onCancel={() => !cleaning && setAsking(null)}
        >
          <ul className="ws-remove-tabs" data-disk-paths="">
            {cleanTargets(asking).map((p) => (
              <li key={p} className="ws-mono">
                {p}
              </li>
            ))}
          </ul>
        </ConfirmDialog>
      )}
    </div>
  );
}
