import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type WorktreeView } from "@/api";
import { useI18n } from "@/i18n";

/** A branch name as the fixed part in front of its last `/` and the leaf the person edits. */
export function splitBranch(branch: string | null): { prefix: string; leaf: string } {
  if (branch === null) return { prefix: "", leaf: "" };
  const cut = branch.lastIndexOf("/") + 1;
  return { prefix: branch.slice(0, cut), leaf: branch.slice(cut) };
}

// These codes have their own words here; the others read as everywhere else.
const OWN = new Set<ApiError["code"]>(["bad_name"]);

/**
 * Renames the branch of a worktree: the prefix stays as fixed text, Suggest asks for a name from the
 * work of the worktree's latest agent session. The folder never moves. Mounted only while open.
 */
export function RenameBranchDialog(props: {
  api: Api;
  worktree: WorktreeView;
  onRenamed(view: WorktreeView): void;
  onClose(): void;
}): JSX.Element {
  const { api, worktree } = props;
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const { prefix, leaf: current } = splitBranch(worktree.branch);
  const [leaf, setLeaf] = useState(current);
  const [busy, setBusy] = useState(false);
  const [suggesting, setSuggesting] = useState(false);
  const [error, setError] = useState<ApiError["code"] | null>(null);

  useEffect(() => {
    const d = dialog.current;
    if (d && typeof d.showModal === "function" && !d.open) d.showModal();
  }, []);

  const typed = leaf.trim();
  const blocked = busy || suggesting || typed === "" || typed === current;

  async function save(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      props.onRenamed(await api.worktreeRenameBranch(worktree.path, typed));
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
    }
  }

  async function suggest(): Promise<void> {
    setSuggesting(true);
    setError(null);
    try {
      setLeaf(await api.worktreeSuggestBranch(worktree.path, null));
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setSuggesting(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-rename-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) props.onClose();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (!blocked) void save();
        }}
      >
        <h2 id="ws-rename-title" className="dialog-title">
          {t("branchRename.title")}
        </h2>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("branchRename.field")}</span>
            <span className="ws-branch-row">
              {prefix !== "" && <span className="ws-mono ws-branch-prefix">{prefix}</span>}
              <input
                type="text"
                name="branchLeaf"
                className="ws-mono"
                value={leaf}
                autoFocus
                spellCheck={false}
                disabled={busy}
                onChange={(e) => setLeaf(e.target.value)}
              />
            </span>
            <small className="settings-hint">{t("branchRename.hint")}</small>
          </label>
        </div>
        {error && (
          <p className="error-text" role="alert">
            {OWN.has(error) ? t(`branchRename.error.${error}`) : t(`error.${error}`)}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" data-suggest="" disabled={busy || suggesting} onClick={() => void suggest()}>
            {suggesting ? t("branchRename.suggesting") : t("branchRename.suggest")}
          </button>
          <button type="button" className="btn-secondary" disabled={busy} onClick={props.onClose}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={blocked}>
            {busy ? t("branchRename.renaming") : t("branchRename.rename")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
