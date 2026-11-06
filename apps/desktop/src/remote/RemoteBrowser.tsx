import { Button, ListRow, Spinner } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type RemoteDirListing } from "@/api";
import { useI18n } from "@/i18n";
import { remoteError } from "./model";

/**
 * The folders of one host, one level at a time: the current path, "Up" and a row per subfolder. It
 * starts in the host's home folder and tells the parent which folder is showing; the parent owns
 * the button that opens it.
 */
export function RemoteBrowser(props: {
  api: Pick<Api, "remoteBrowse">;
  hostId: string;
  /** The host's alias, for the title and the error texts. */
  host: string;
  /** Called with the folder now showing, or null while there is none (loading the first time, or a failed first load). */
  onPath(path: string | null): void;
}): JSX.Element {
  const { api, hostId, host } = props;
  const { t } = useI18n();
  const [listing, setListing] = useState<RemoteDirListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ApiError["code"] | null>(null);
  // The newest request wins; a slow listing of an older folder is dropped.
  const seq = useRef(0);
  const onPath = useRef(props.onPath);
  onPath.current = props.onPath;

  function load(path?: string): void {
    const mine = ++seq.current;
    setLoading(true);
    setError(null);
    void Promise.resolve()
      .then(() => api.remoteBrowse(hostId, path))
      .then(
        (next) => {
          if (mine !== seq.current) return;
          setListing(next);
          setLoading(false);
          onPath.current(next.path);
        },
        (e: unknown) => {
          if (mine !== seq.current) return;
          setError(toApiError(e).code);
          setLoading(false);
        },
      );
  }

  useEffect(() => {
    setListing(null);
    onPath.current(null);
    load();
    return () => {
      seq.current++;
    };
    // A new host starts again from its home folder.
  }, [api, hostId]);

  return (
    <section className="remote-browser" aria-label={t("remote.browse.title", { host })}>
      <div className="remote-browser-bar">
        <Button type="button" variant="secondary" disabled={loading || listing?.parent == null} onClick={() => listing?.parent != null && load(listing.parent)}>
          {t("remote.browse.up")}
        </Button>
        <span className="remote-browser-path" data-testid="remote-path">
          {listing?.path ?? ""}
        </span>
        {loading && <Spinner size="sm" label={t("remote.browse.loading", { host })} />}
      </div>
      {error && (
        <p className="error-text" role="alert">
          {remoteError(t, error, host)}
        </p>
      )}
      {listing && listing.dirs.length > 0 && (
        <ul className="remote-browser-list">
          {listing.dirs.map((d) => (
            <ListRow key={d.path} as="li" title={d.name} disabled={loading} onClick={() => load(d.path)} />
          ))}
        </ul>
      )}
      {listing && listing.dirs.length === 0 && !loading && <p className="settings-hint">{t("remote.browse.empty")}</p>}
      {listing?.truncated && <p className="settings-hint">{t("remote.browse.truncated")}</p>}
    </section>
  );
}
