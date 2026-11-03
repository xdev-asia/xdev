import { Button } from "@xdev/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { toApiError, type Api, type RepoView } from "@/api";
import { useI18n } from "@/i18n";

type CloneApi = Pick<Api, "repoClone" | "repoCloneCancel" | "repoCloneName" | "pickFolder">;

/** The folder holding `path`, without a trailing separator; "" when there is none. */
export function parentOf(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const cut = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (cut < 0) return "";
  // `C:\code` has the drive as its parent; `/code` has the root.
  return cut === 0 ? trimmed.slice(0, 1) : /^[A-Za-z]:$/.test(trimmed.slice(0, cut)) ? trimmed.slice(0, cut + 1) : trimmed.slice(0, cut);
}

/** The line under the form while a clone runs: the phase, with its percent when it has one. */
export function progressLine(p: { phase: string; percent: number | null }): string {
  return p.percent === null ? p.phase : `${p.phase} ${Math.round(p.percent)}%`;
}

/**
 * Add project: Open folder… (an existing checkout) or Clone from URL. A clone shows its phase and
 * percent, can be cancelled, and on `done` hands the new repo to `onCloned`. A failed clone keeps
 * the form with the message. Mounted only while open.
 */
export function AddProjectDialog(props: {
  api: CloneApi;
  /** The Folder field's first value: the parent of the last added repo. */
  startFolder: string;
  onOpenFolder(): void;
  onCloned(repo: RepoView): void;
  onCancel(): void;
}): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"choose" | "clone">("choose");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState(props.startFolder);
  const [name, setName] = useState("");
  // Once the person edits Name, typing the URL stops overwriting it.
  const [nameEdited, setNameEdited] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number | null } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  // The run in flight and the newest Name lookup, read from callbacks that outlive a render.
  const [run] = useState(() => ({ id: "", lookups: 0, runs: 0, message: undefined as string | undefined }));

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  function typeUrl(next: string): void {
    setUrl(next);
    if (nameEdited) return;
    const mine = ++run.lookups;
    api.repoCloneName(next.trim()).then(
      (n) => mine === run.lookups && setName(n),
      () => mine === run.lookups && setName(""),
    );
  }

  async function choose(): Promise<void> {
    const picked = await api.pickFolder().catch(() => null);
    if (picked) setFolder(picked);
  }

  async function clone(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy || !url.trim() || !folder.trim() || !name.trim()) return;
    const id = `clone-${Date.now()}-${++run.runs}`;
    run.id = id;
    run.message = undefined;
    setBusy(true);
    setError(undefined);
    setProgress(null);
    let done = false;
    try {
      await api.repoClone(url.trim(), folder.trim(), name.trim(), id, (event) => {
        if (event.type === "phase") setProgress({ phase: event.phase, percent: event.percent });
        else if (event.type === "error") run.message = event.message;
        else {
          done = true;
          props.onCloned(event.repo);
        }
      });
    } catch (err) {
      if (done) return;
      const apiErr = toApiError(err);
      // A cancel is the person's own choice: back to the form without an error.
      if (apiErr.code !== "cancelled") setError(run.message ?? t(`error.${apiErr.code}`));
    }
    if (done) return;
    setBusy(false);
    setProgress(null);
  }

  // Cancel stops a running clone and stays in the form; with nothing running it closes the dialog.
  function cancel(): void {
    if (busy) void api.repoCloneCancel(run.id).catch(() => undefined);
    else props.onCancel();
  }

  const ready = !busy && url.trim() !== "" && folder.trim() !== "" && name.trim() !== "";

  return (
    <dialog
      ref={dialog}
      role="dialog"
      aria-modal="true"
      className="dialog ws-dialog"
      aria-labelledby="ws-add-project-heading"
      onCancel={(e) => {
        e.preventDefault();
        cancel();
      }}
    >
      <h2 id="ws-add-project-heading" className="dialog-title">
        {t("addProject.title")}
      </h2>
      {mode === "choose" ? (
        <>
          <div className="ws-add-choices">
            <button type="button" className="btn-secondary" data-choice="folder" onClick={props.onOpenFolder}>
              {t("addProject.openFolder")}
            </button>
            <button type="button" className="btn-secondary" data-choice="clone" onClick={() => setMode("clone")}>
              {t("addProject.cloneFromUrl")}
            </button>
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={props.onCancel}>
              {t("dialog.cancel")}
            </button>
          </div>
        </>
      ) : (
        <form onSubmit={(e) => void clone(e)}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("addProject.url")}</span>
              <input name="url" className="ws-mono" autoFocus spellCheck={false} disabled={busy} value={url} onChange={(e) => typeUrl(e.target.value)} />
            </label>
            <div className="ws-field" role="group" aria-labelledby="ws-add-folder-label">
              <span id="ws-add-folder-label">{t("addProject.folder")}</span>
              <div className="settings-row">
                <input name="folder" className="ws-mono" spellCheck={false} disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button type="button" className="btn-secondary" data-act="choose" disabled={busy} onClick={() => void choose()}>
                  {t("addProject.choose")}
                </button>
              </div>
            </div>
            <label className="ws-field">
              <span>{t("addProject.name")}</span>
              <input
                name="name"
                className="ws-mono"
                spellCheck={false}
                disabled={busy}
                value={name}
                onChange={(e) => {
                  setNameEdited(true);
                  setName(e.target.value);
                }}
              />
            </label>
          </div>
          {progress && (
            <p className="dialog-body" role="status" data-progress>
              {progressLine(progress)}
            </p>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" data-act="cancel" onClick={cancel}>
              {t("dialog.cancel")}
            </button>
            <Button type="submit" disabled={!ready}>
              {t("addProject.clone")}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
