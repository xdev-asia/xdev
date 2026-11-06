import { Button, Select } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { toApiError, type Api, type ApiError, type RemoteHostView, type RemoteTarget } from "@/api";
import { useI18n } from "@/i18n";
import { RemoteBrowser } from "./RemoteBrowser";
import { remoteError } from "./model";

/**
 * Set remote target: a host and a folder on it where this local project's agents and terminals can
 * run. Files are not copied. Mounted only while open.
 */
export function RemoteTargetDialog(props: {
  api: Pick<Api, "remoteHostsState" | "remoteBrowse" | "remoteTargetSet">;
  repoId: string;
  project: string;
  current: RemoteTarget | null;
  onSaved(target: RemoteTarget | null): void;
  onCancel(): void;
}): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [hosts, setHosts] = useState<RemoteHostView[] | null>(null);
  const [hostId, setHostId] = useState(props.current?.hostId ?? "");
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"] | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => api.remoteHostsState())
      .then(
        (list) => {
          if (!live) return;
          setHosts(list);
          setHostId((cur) => cur || list[0]?.hostId || "");
        },
        () => live && setHosts([]),
      );
    return () => {
      live = false;
    };
  }, [api]);

  const host = hosts?.find((h) => h.hostId === hostId);

  async function save(target: RemoteTarget | null, e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.remoteTargetSet(props.repoId, target);
      props.onSaved(target);
    } catch (err) {
      setError(toApiError(err).code);
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="remote-target-heading"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="remote-target-heading" className="dialog-title">
        {t("remote.target.title", { project: props.project })}
      </h2>
      <form onSubmit={(e) => void save(host && path ? { hostId: host.hostId, path } : null, e)}>
        <div className="remote-fields">
          <p className="settings-hint">{t("remote.target.note")}</p>
          <label className="ws-field">
            <span>{t("remote.add.host")}</span>
            <Select name="host" value={hostId} disabled={busy || hosts === null} onChange={(e) => setHostId(e.target.value)} options={(hosts ?? []).map((h) => ({ value: h.hostId, label: h.alias }))} />
          </label>
          {host && <RemoteBrowser api={api} hostId={host.hostId} host={host.alias} onPath={setPath} />}
        </div>
        {error && host && (
          <p className="error-text" role="alert">
            {remoteError(t, error, host.alias)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" disabled={busy} onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          {props.current && (
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => void save(null)}>
              {t("remote.target.clear")}
            </button>
          )}
          <Button type="submit" disabled={busy || !host || !path}>
            {t("remote.target.save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
