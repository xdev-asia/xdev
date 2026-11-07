import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, JSX } from "react";
import { toApiError, type Api, type Created, type ProjectKind, type RemoteProjectView, type RepoView } from "@/api";
import { useI18n } from "@/i18n";
import { AddRemoteFolder } from "@/remote/AddRemoteFolder";
import { NestedRepoChecklist } from "./NestedRepoChecklist";

type CloneApi = Pick<Api, "repoClone" | "repoCloneCancel" | "repoCloneName" | "repoCreate" | "pickFolder"> & Partial<Pick<Api, "scanNestedRepos" | "cancelNestedScan" | "remoteHostsState" | "remoteBrowse" | "remoteProjectAdd">>;

/** Which field a refused Create points at; the rest show under the form. */
const CREATE_FIELD: Record<string, "name" | "folder"> = { bad_name: "name", exists: "name", not_found: "folder" };

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
 * Add project: Open folder… (an existing checkout), Clone from URL or Create new. A clone shows its
 * phase and percent, can be cancelled, and on `done` hands the new repo to `onCloned`. A failed clone
 * keeps the form with the message. Create new makes a Git repository or a plain folder and hands it
 * to `onCreated`. Mounted only while open.
 */
export function AddProjectDialog(props: {
  api: CloneApi;
  /** The Folder field's first value: the parent of the last added repo. */
  startFolder: string;
  onOpenFolder(): void;
  onCloned(repo: RepoView): void;
  onCreated(created: Created): void;
  onCancel(): void;
  /** A folder to scan for repositories as soon as the dialog opens (a picked folder that is no repo). */
  scanRoot?: string;
  /** Adds the repositories ticked in the scan step. */
  onAddRepos?(paths: string[]): void;
  /** A remote project was added over SSH. */
  onRemoteAdded?(project: RemoteProjectView): void;
  /** Opens on the remote folder step. */
  startRemote?: boolean;
  /** Opens on the clone step. */
  startClone?: boolean;
  /** Opens Settings → SSH, for the person with no saved host. */
  onOpenSettings?(): void;
}): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<"choose" | "clone" | "create" | "scan" | "remote">(props.scanRoot ? "scan" : props.startRemote ? "remote" : props.startClone ? "clone" : "choose");
  const [scanRoot, setScanRoot] = useState(props.scanRoot ?? "");
  const [url, setUrl] = useState("");
  const [folder, setFolder] = useState(props.startFolder);
  const [name, setName] = useState("");
  // Once the person edits Name, typing the URL stops overwriting it.
  const [nameEdited, setNameEdited] = useState(false);
  const [progress, setProgress] = useState<{ phase: string; percent: number | null } | null>(null);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<ProjectKind>("git");
  const [branch, setBranch] = useState("");
  const [firstCommit, setFirstCommit] = useState(true);
  // Where a refused Create points: the Name or Folder field, or under the form.
  const [fieldError, setFieldError] = useState<{ field: "name" | "folder" | "form"; code: string }>();
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

  async function scan(): Promise<void> {
    const picked = await api.pickFolder().catch(() => null);
    if (!picked) return;
    setScanRoot(picked);
    setMode("scan");
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

  async function create(e?: FormEvent): Promise<void> {
    e?.preventDefault();
    if (busy || !folder.trim() || !name.trim()) return;
    setBusy(true);
    setFieldError(undefined);
    try {
      const created = await api.repoCreate({ parent: folder.trim(), name: name.trim(), kind, branch: branch.trim(), firstCommit });
      props.onCreated(created);
    } catch (err) {
      const { code } = toApiError(err);
      setFieldError({ field: CREATE_FIELD[code] ?? "form", code });
      setBusy(false);
    }
  }

  function back(): void {
    setMode("choose");
    setFieldError(undefined);
    setError(undefined);
  }

  // Cancel stops a running clone and stays in the form; with nothing running it closes the dialog.
  function cancel(): void {
    if (busy) void api.repoCloneCancel(run.id).catch(() => undefined);
    else props.onCancel();
  }

  const createReady = !busy && folder.trim() !== "" && name.trim() !== "";
  // Create has its own wording: the shared `bad_name` and `exists` texts are about account names.
  const createError = (code: string): string => {
    const own = `addProject.create.error.${code}`;
    return t(own) === own ? t(`error.${code}`) : t(own);
  };
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
            <button type="button" className="btn-secondary" data-choice="create" onClick={() => setMode("create")}>
              {t("addProject.create.choice")}
            </button>
            {api.remoteHostsState && api.remoteBrowse && api.remoteProjectAdd && props.onRemoteAdded && (
              <button type="button" className="btn-secondary" data-choice="remote" onClick={() => setMode("remote")}>
                {t("remote.add.option")}
              </button>
            )}
            {api.scanNestedRepos && api.cancelNestedScan && props.onAddRepos && (
              <button type="button" className="btn-secondary" data-choice="scan" onClick={() => void scan()}>
                {t("nested.choice")}
              </button>
            )}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" onClick={props.onCancel}>
              {t("dialog.cancel")}
            </button>
          </div>
        </>
      ) : mode === "scan" && api.scanNestedRepos && api.cancelNestedScan ? (
        <NestedRepoChecklist
          api={{ scanNestedRepos: api.scanNestedRepos, cancelNestedScan: api.cancelNestedScan }}
          root={scanRoot}
          onAdd={(paths) => props.onAddRepos?.(paths)}
          onBack={back}
        />
      ) : mode === "remote" && api.remoteHostsState && api.remoteBrowse && api.remoteProjectAdd ? (
        <AddRemoteFolder
          api={{ remoteHostsState: api.remoteHostsState, remoteBrowse: api.remoteBrowse, remoteProjectAdd: api.remoteProjectAdd }}
          onAdded={(p) => props.onRemoteAdded?.(p)}
          onBack={back}
          onOpenSettings={() => props.onOpenSettings?.()}
        />
      ) : mode === "create" ? (
        <form onSubmit={(e) => void create(e)}>
          <div className="ws-fields">
            <div className="ws-field" role="group" aria-labelledby="ws-create-folder-label">
              <span id="ws-create-folder-label">{t("addProject.folder")}</span>
              <div className="settings-row">
                <input name="folder" className="ws-mono" autoFocus spellCheck={false} disabled={busy} value={folder} onChange={(e) => setFolder(e.target.value)} />
                <button type="button" className="btn-secondary" data-act="choose" disabled={busy} onClick={() => void choose()}>
                  {t("addProject.choose")}
                </button>
              </div>
              {fieldError?.field === "folder" && (
                <span className="error-text" role="alert">
                  {createError(fieldError.code)}
                </span>
              )}
            </div>
            <label className="ws-field">
              <span>{t("addProject.name")}</span>
              <input name="name" className="ws-mono" spellCheck={false} disabled={busy} value={name} onChange={(e) => setName(e.target.value)} />
              {fieldError?.field === "name" && (
                <span className="error-text" role="alert">
                  {createError(fieldError.code)}
                </span>
              )}
            </label>
            <div className="ws-field" role="radiogroup" aria-labelledby="ws-create-kind-label">
              <span id="ws-create-kind-label">{t("addProject.create.kind")}</span>
              {(["git", "folder"] as const).map((k) => (
                <label key={k} className="ws-tick">
                  <input type="radio" name="kind" value={k} disabled={busy} checked={kind === k} onChange={() => setKind(k)} />
                  <span>{t(`addProject.create.kind.${k}`)}</span>
                </label>
              ))}
            </div>
            {kind === "git" && (
              <details>
                <summary>{t("addProject.create.advanced")}</summary>
                <label className="ws-field">
                  <span>{t("addProject.create.branch")}</span>
                  <input name="branch" className="ws-mono" placeholder="main" spellCheck={false} disabled={busy} value={branch} onChange={(e) => setBranch(e.target.value)} />
                </label>
                <label className="ws-tick">
                  <input type="checkbox" name="firstCommit" disabled={busy} checked={firstCommit} onChange={(e) => setFirstCommit(e.target.checked)} />
                  <span>{t("addProject.create.firstCommit")}</span>
                </label>
              </details>
            )}
          </div>
          {fieldError?.field === "form" && (
            <p className="error-text" role="alert">
              {createError(fieldError.code)}
            </p>
          )}
          <div className="dialog-actions">
            <button type="button" className="btn-secondary" data-act="back" disabled={busy} onClick={back}>
              {t("dialog.cancel")}
            </button>
            <Button variant="primary" type="submit" disabled={!createReady}>
              {t("addProject.create.submit")}
            </Button>
          </div>
        </form>
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
            <Button variant="primary" type="submit" disabled={!ready}>
              {t("addProject.clone")}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}
