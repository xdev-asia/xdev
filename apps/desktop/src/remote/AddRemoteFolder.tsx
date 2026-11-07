import { Button, EmptyState, Field, Select } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { FormEvent, JSX } from "react";
import { toApiError, type Api, type ApiError, type RemoteHostView, type RemoteProjectView } from "@/api";
import { useI18n } from "@/i18n";
import { RemoteBrowser } from "./RemoteBrowser";
import { lastSegment, remoteError } from "./model";

/**
 * Add project → Remote folder over SSH: a host, a folder on it and a name. With no saved host it
 * points to Settings → SSH instead. Primary action: Open folder.
 */
export function AddRemoteFolder(props: {
  api: Pick<Api, "remoteHostsState" | "remoteBrowse" | "remoteProjectAdd">;
  onAdded(project: RemoteProjectView): void;
  onBack(): void;
  onOpenSettings(): void;
}): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [hosts, setHosts] = useState<RemoteHostView[] | null>(null);
  const [hostId, setHostId] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"] | null>(null);

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

  function folder(next: string | null): void {
    setPath(next);
    if (next !== null && !nameEdited) setName(lastSegment(next));
  }

  async function submit(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy || !host || !path) return;
    setBusy(true);
    setError(null);
    try {
      props.onAdded(await api.remoteProjectAdd(host.hostId, path, name.trim() || undefined));
    } catch (err) {
      setError(toApiError(err).code);
      setBusy(false);
    }
  }

  if (hosts !== null && hosts.length === 0) {
    return (
      <div>
        <EmptyState
          size="inline"
          title={t("remote.add.noHosts")}
          hint={t("remote.add.noHosts.hint")}
          actions={
            <Button variant="primary" type="button" onClick={props.onOpenSettings}>
              {t("remote.add.openSettings")}
            </Button>
          }
        />
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" data-act="back" onClick={props.onBack}>
            {t("dialog.cancel")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void submit(e)}>
      <div className="remote-fields">
        <label className="ws-field">
          <span>{t("remote.add.host")}</span>
          <Select name="host" value={hostId} disabled={busy || hosts === null} onChange={(e) => setHostId(e.target.value)} options={(hosts ?? []).map((h) => ({ value: h.hostId, label: h.alias }))} />
        </label>
        {host && <RemoteBrowser api={api} hostId={host.hostId} host={host.alias} onPath={folder} />}
        <Field
          label={t("remote.add.name")}
          name="name"
          spellCheck={false}
          disabled={busy}
          value={name}
          onChange={(e) => {
            setNameEdited(true);
            setName(e.target.value);
          }}
        />
      </div>
      {error && host && (
        <p className="error-text" role="alert">
          {remoteError(t, error, host.alias)}
        </p>
      )}
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" data-act="back" disabled={busy} onClick={props.onBack}>
          {t("dialog.cancel")}
        </button>
        <Button variant="primary" type="submit" disabled={busy || !host || !path}>
          {t("remote.add.submit")}
        </Button>
      </div>
    </form>
  );
}
