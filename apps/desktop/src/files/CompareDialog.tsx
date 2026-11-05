import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api } from "@/api";
import { DiffView } from "@/components/DiffView";
import { ImageDiff } from "@/review/ImageDiff";
import { isImagePath } from "@/review/imageDiffModel";
import { useI18n } from "@/i18n";

/** What reading the file from disk gave, for the comparison. */
export type DiskState = { kind: "reading" } | { kind: "error"; error: string } | { kind: "binary" } | { kind: "text"; disk: string };

/** Reads `rel` as it is on disk now. A file that is not text has nothing to compare. */
export async function readDisk(api: Api, worktree: string, rel: string): Promise<DiskState> {
  try {
    const file = await api.fileRead(worktree, rel);
    return file.kind === "text" ? { kind: "text", disk: file.text ?? "" } : { kind: "binary" };
  } catch (e) {
    return { kind: "error", error: toApiError(e).code };
  }
}

/** The dialog's body for each state: a line of words, or the diff with the disk version as the base. */
export function CompareBody(props: { state: DiskState; current: string; image?: { api: Api; worktree: string; rel: string } }): JSX.Element {
  const { t } = useI18n();
  const { state } = props;
  if (state.kind === "reading") return <p className="dialog-body" role="status">{t("files.external.reading")}</p>;
  // A changed image is shown as images: the committed one and the one on disk.
  if (state.kind === "binary" && props.image && isImagePath(props.image.rel)) {
    const { api, worktree, rel } = props.image;
    return (
      <div className="file-compare-diff">
        <ImageDiff api={api} worktree={worktree} path={rel} kind="modified" base={null} />
      </div>
    );
  }
  if (state.kind === "binary") return <p className="dialog-body">{t("files.external.binary")}</p>;
  if (state.kind === "error") return <p className="dialog-warn">{t("files.external.readError", { error: t(`error.${state.error}`) })}</p>;
  return (
    <div className="file-compare-diff">
      <DiffView base={state.disk} current={props.current} />
    </div>
  );
}

/**
 * The disk version beside the unsaved edits. Mounted only while it is open. Reload is the one primary
 * action; closing changes nothing.
 */
export function CompareDialog(props: { api: Api; worktree: string; rel: string; current: string; onReload(): void; onClose(): void }): JSX.Element {
  const { api, worktree, rel, current, onReload, onClose } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [state, setState] = useState<DiskState>({ kind: "reading" });

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  useEffect(() => {
    let live = true;
    void readDisk(api, worktree, rel).then((next) => live && setState(next));
    return () => {
      live = false;
    };
  }, [api, worktree, rel]);

  return (
    <dialog
      ref={dialog}
      className="dialog file-compare"
      aria-labelledby="file-compare-title"
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
    >
      <h2 id="file-compare-title" className="dialog-title">{t("files.external.compareTitle")}</h2>
      <p className="dialog-body">{t("files.external.compareBody")}</p>
      <CompareBody state={state} current={current} image={{ api, worktree, rel }} />
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" autoFocus onClick={onClose}>{t("dialog.close")}</button>
        <Button type="button" onClick={onReload}>{t("files.external.reload")}</Button>
      </div>
    </dialog>
  );
}
