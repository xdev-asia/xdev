import { Dialog } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { Api, ResourceSnapshot } from "@/api";
import { useI18n } from "@/i18n";
import { formatBytes, formatCpu, sortRows } from "./resourceRows";

/** How often the open view reads the process table. */
export const RESOURCE_REFRESH_MS = 3000;

export interface ResourceTab {
  id: string;
  title: string;
  agent: string;
}

export interface ResourceManagerProps {
  api: Pick<Api, "resourcesSnapshot">;
  /** The open tabs, for the title and agent of a row. */
  tabs(): ResourceTab[];
  /** Stops the tab (the same path as closing it). */
  onStop(id: string): Promise<void>;
  onClose(): void;
}

/** CPU and memory of every running tab and of the app, biggest memory first, read every 3 s while open. */
export function ResourceManager(props: ResourceManagerProps): JSX.Element {
  const { api, tabs, onStop, onClose } = props;
  const { t } = useI18n();
  const [snap, setSnap] = useState<ResourceSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<ResourceTab | null>(null);
  const [status, setStatus] = useState("");
  const reload = useRef<() => void>(() => {});

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const again = () => {
      if (live) timer = setTimeout(read, RESOURCE_REFRESH_MS);
    };
    const read = () => {
      api.resourcesSnapshot().then(
        (s) => {
          if (!live) return;
          setSnap(s);
          setFailed(s === null);
          again();
        },
        () => {
          if (!live) return;
          setFailed(true);
          again();
        },
      );
    };
    reload.current = () => {
      if (timer) clearTimeout(timer);
      read();
    };
    read();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api]);

  const known = new Map(tabs().map((x) => [x.id, x]));
  const rows = snap ? sortRows(snap.tabs) : [];

  if (confirm) {
    return (
      <Dialog
        modal
        alert
        title={t("resources.stop.title", { name: confirm.title })}
        confirmLabel={t("resources.stop")}
        cancelLabel={t("dialog.cancel")}
        onCancel={() => setConfirm(null)}
        onConfirm={() => {
          const target = confirm;
          setConfirm(null);
          onStop(target.id)
            .then(
              () => setStatus(t("resources.stopped", { name: target.title })),
              () => setStatus(t("resources.stop.failed", { name: target.title })),
            )
            .finally(() => reload.current());
        }}
      >
        {t("resources.stop.body")}
      </Dialog>
    );
  }

  return (
    <Dialog modal size="wide" title={t("resources.title")} confirmLabel={t("resources.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose} body="plain">
      <div className="res-view" data-resources>
        <p className="settings-hint">{t("resources.hint")}</p>
        {failed && (
          <p className="kit-empty" data-resources-error>
            {t("resources.error")}
          </p>
        )}
        {snap && (
          <ul className="res-list" aria-label={t("resources.title")}>
            <li className="res-row" data-resource-app>
              <div className="res-name">
                <strong>{t("resources.app")}</strong>
              </div>
              <span className="res-metric">
                {`${t("resources.cpu")} ${formatCpu(snap.app.cpu)}`}
              </span>
              <span className="res-metric">
                {`${t("resources.memory")} ${formatBytes(snap.app.memoryBytes)}`}
              </span>
            </li>
            {rows.map((r) => {
              const tab = known.get(r.tabId ?? "") ?? { id: r.tabId ?? "", title: r.tabId ?? "", agent: "" };
              return (
                <li className="res-row" key={r.tabId} data-resource-tab={r.tabId}>
                  <div className="res-name">
                    <strong>{tab.title}</strong>
                    {tab.agent && <span className="res-sub">{tab.agent}</span>}
                    <span className="res-sub">{t("resources.processes", { count: r.processes })}</span>
                  </div>
                  <span className="res-metric">
                    {`${t("resources.cpu")} ${formatCpu(r.cpu)}`}
                  </span>
                  <span className="res-metric">
                    {`${t("resources.memory")} ${formatBytes(r.memoryBytes)}`}
                  </span>
                  <button type="button" className="btn-secondary" aria-label={t("resources.stop.label", { name: tab.title })} onClick={() => setConfirm(tab)}>
                    {t("resources.stop")}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {snap && rows.length === 0 && <p className="kit-empty">{t("resources.empty")}</p>}
        <p role="status" className="settings-hint">
          {status}
        </p>
      </div>
    </Dialog>
  );
}
