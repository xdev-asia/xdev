import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Button, Checkbox, Spinner } from "@xdev-asia/ui";
import { toApiError, type Api, type NestedRepo } from "@/api";
import { useI18n } from "@/i18n";

type ScanApi = Pick<Api, "scanNestedRepos" | "cancelNestedScan">;

/** The paths a fresh scan starts with checked: every repo that is not listed yet. */
export function preChecked(repos: readonly NestedRepo[]): string[] {
  return repos.filter((r) => !r.registered).map((r) => r.path);
}

/**
 * Scans `root` for repositories: progress with Cancel, then a checklist of what was found (the ones not
 * listed yet start checked) and Add selected. A cancelled scan keeps what it had found. Mounted only
 * while the scan step is shown; leaving it stops a scan still running.
 */
export function NestedRepoChecklist(props: { api: ScanApi; root: string; onAdd(paths: string[]): void; onBack(): void }): JSX.Element {
  const { api, root } = props;
  const { t } = useI18n();
  const [state, setState] = useState<{ phase: "scanning" } | { phase: "done"; repos: NestedRepo[]; cancelled: boolean } | { phase: "error"; code: string }>({ phase: "scanning" });
  const [checked, setChecked] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    api.scanNestedRepos(root).then(
      (found) => {
        if (!live) return;
        setChecked(preChecked(found.repos));
        setState({ phase: "done", repos: found.repos, cancelled: found.cancelled });
      },
      (e: unknown) => live && setState({ phase: "error", code: toApiError(e).code }),
    );
    return () => {
      live = false;
      void api.cancelNestedScan().catch(() => undefined);
    };
  }, [api, root]);

  const toggle = (path: string, on: boolean) => setChecked(on ? [...checked.filter((p) => p !== path), path] : checked.filter((p) => p !== path));
  return (
    <div className="ws-nested">
      <p className="ws-nested-root ws-mono" title={root}>
        {root}
      </p>
      {state.phase === "scanning" && (
        <p className="dialog-body ws-nested-progress" role="status">
          <Spinner label={t("nested.scanning")} />
          <span>{t("nested.scanning")}</span>
        </p>
      )}
      {state.phase === "error" && (
        <p className="error-text" role="alert">
          {t(`error.${state.code}`)}
        </p>
      )}
      {state.phase === "done" && (
        <>
          {state.cancelled && (
            <p className="dialog-body" role="status">
              {t("nested.cancelled", { count: state.repos.length })}
            </p>
          )}
          {state.repos.length === 0 ? (
            <p className="ws-empty">{t("nested.none")}</p>
          ) : (
            <ul className="ws-nested-list" aria-label={t("nested.list")}>
              {state.repos.map((repo) => (
                <li key={repo.path} className="ws-nested-row" title={repo.path}>
                  <Checkbox label={repo.name} hint={repo.path} disabled={repo.registered} checked={!repo.registered && checked.includes(repo.path)} onChange={(e) => toggle(repo.path, e.target.checked)} />
                  {repo.registered && <span className="ws-chip">{t("nested.registered")}</span>}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      <div className="dialog-actions">
        <Button variant="secondary" onClick={state.phase === "scanning" ? () => void api.cancelNestedScan().catch(() => undefined) : props.onBack}>
          {state.phase === "scanning" ? t("nested.cancel") : t("nested.back")}
        </Button>
        {state.phase === "done" && (
          <Button disabled={checked.length === 0} onClick={() => props.onAdd(checked)}>
            {t("nested.addSelected", { count: checked.length })}
          </Button>
        )}
      </div>
    </div>
  );
}
