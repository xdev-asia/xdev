import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { ImageSession } from "./imageSession";
import { LoadError } from "./LoadError";
import { formatBytes } from "./viewer";

/** One audio or video file: bytes become an object URL for a native player. */
export function MediaView(props: { api: Api; worktree: string; rel: string }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  // The session only loads bytes into an object URL; zoom is not used here.
  const session = useMemo(() => new ImageSession(api, worktree, rel), [api, worktree, rel]);
  const state = useSyncExternalStore(session.subscribe, session.get);
  useEffect(() => {
    void session.load();
    return () => session.dispose();
  }, [session]);
  const name = rel.split("/").pop() ?? rel;
  const video = /\.(mp4|webm|ogv|mov)$/i.test(rel);
  const reveal = () => void api.fileReveal(worktree, rel).catch(() => undefined);
  const openDefault = () =>
    void api.fileOpenDefault(worktree, rel).catch(() => pushToast({ id: "open-default", text: t("files.openDefault.failed") }));
  const openButton = (
    <button type="button" className="btn-secondary" onClick={openDefault}>
      {t("files.openDefault")}
    </button>
  );

  if (state.status === "error") {
    if (state.error === "too_large") {
      return (
        <div className="file-note">
          <p className="ws-empty">{t("error.too_large")}</p>
          <p className="file-note-body">{t("files.media.tooLarge.body")}</p>
          {openButton}
        </div>
      );
    }
    return <LoadError code={state.error ?? "io"} onRetry={() => void session.load()} onReveal={reveal} />;
  }
  return (
    <div className="media-view">
      <div className="media-bar">
        <span className="media-name" title={rel}>{name}</span>
        {state.status === "ready" && <span className="media-meta">{formatBytes(state.bytes)}</span>}
        {openButton}
      </div>
      {state.status === "loading" || !state.url ? (
        <p className="ws-empty">{t("files.image.loading")}</p>
      ) : (
        <div className="media-player">
          {video ? (
            <video src={state.url} controls preload="metadata" aria-label={name}>
              {t("files.media.failed")}
            </video>
          ) : (
            <audio src={state.url} controls preload="metadata" aria-label={name}>
              {t("files.media.failed")}
            </audio>
          )}
        </div>
      )}
    </div>
  );
}
