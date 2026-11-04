import { Button } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { ApiError, DetailsPatch, WorkItemKind, WorkStatus, WorktreeView } from "@/api";
import { useI18n } from "@/i18n";
import { expandShortcodes } from "./emoji";
import { parseItem } from "./workItemInput";

const STATUSES: WorkStatus[] = ["todo", "in-progress", "in-review", "completed"];

type Form = { title: string; comment: string; status: string; parent: string; itemUrl: string; itemKind: WorkItemKind };

/** Only the fields that differ from the worktree; null while the work item link is unusable. */
export function detailsPatch(wt: WorktreeView, form: Form): DetailsPatch | null {
  const item = parseItem(form.itemUrl, form.itemKind);
  if (item === "bad") return null;
  const patch: DetailsPatch = {};
  const title = form.title.trim() === "" ? null : form.title.trim();
  if (title !== (wt.title ?? null)) patch.title = title;
  if (form.comment !== wt.comment) patch.comment = form.comment;
  const status = form.status === "" ? null : (form.status as WorkStatus);
  if (status !== (wt.status ?? null)) patch.status = status;
  const parent = form.parent === "" ? null : form.parent;
  if (parent !== (wt.parent ?? null)) patch.parent = parent;
  const same = item === null ? wt.item === null : wt.item !== null && wt.item.url === item.url && wt.item.kind === item.kind;
  if (!same) patch.item = item;
  return patch;
}

/** Title, comment, status, work item and parent of one worktree. Mounted only while open. */
export function DetailsDialog(props: {
  worktree: WorktreeView;
  /** The other worktrees of the repo, for the parent choice. */
  siblings: WorktreeView[];
  busy: boolean;
  error?: ApiError["code"];
  onSave(patch: DetailsPatch): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const wt = props.worktree;
  const dialog = useRef<HTMLDialogElement>(null);
  const [title, setTitle] = useState(wt.title ?? "");
  const [comment, setComment] = useState(wt.comment);
  const [status, setStatus] = useState<string>(wt.status ?? "");
  const [parent, setParent] = useState(wt.parent ?? "");
  const [itemUrl, setItemUrl] = useState(wt.item?.url ?? "");
  const [itemKind, setItemKind] = useState<WorkItemKind>(wt.item?.kind ?? "pr");

  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);

  // A parent is another worktree that is not the main checkout and not itself a child.
  const parents = props.siblings.filter((s) => s.path !== wt.path && !s.primary && (s.parent === null || s.path === wt.parent));
  const badItem = parseItem(itemUrl, itemKind) === "bad";
  const error = props.error === undefined ? undefined : t(`error.${props.error}`);

  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-details-title"
      onCancel={(e) => {
        e.preventDefault();
        if (!props.busy) props.onCancel();
      }}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (props.busy) return;
          const patch = detailsPatch(wt, { title, comment, status, parent, itemUrl, itemKind });
          if (patch) props.onSave(patch);
        }}
      >
        <h2 id="ws-details-title" className="dialog-title">
          {t("workspace.details.title", { name: wt.title ?? wt.name })}
        </h2>
        <div className="ws-fields">
          <label className="ws-field">
            <span>{t("workspace.details.titleField")}</span>
            <input type="text" value={title} autoFocus disabled={props.busy} spellCheck={false} onChange={(e) => setTitle(expandShortcodes(e.target.value))} />
          </label>
          <label className="ws-field">
            <span>{t("workspace.details.comment")}</span>
            <textarea value={comment} rows={3} disabled={props.busy} onChange={(e) => setComment(e.target.value)} />
          </label>
          <label className="ws-field">
            <span>{t("workspace.details.status")}</span>
            <select value={status} disabled={props.busy} onChange={(e) => setStatus(e.target.value)}>
              <option value="">{t("workspace.details.noStatus")}</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`workspace.work.${s}`)}
                </option>
              ))}
            </select>
          </label>
          <label className="ws-field">
            <span>{t("workspace.create.parent")}</span>
            <select value={parent} disabled={props.busy} onChange={(e) => setParent(e.target.value)}>
              <option value="">{t("workspace.create.noParent")}</option>
              {parents.map((s) => (
                <option key={s.path} value={s.path}>
                  {s.title ?? s.name}
                </option>
              ))}
            </select>
          </label>
          <div className="ws-field">
            <span>{t("workspace.create.item")}</span>
            <div className="ws-item-row">
              <select aria-label={t("workspace.create.itemKind")} value={itemKind} disabled={props.busy} onChange={(e) => setItemKind(e.target.value as WorkItemKind)}>
                <option value="pr">{t("workItem.kind.pr")}</option>
                <option value="issue">{t("workItem.kind.issue")}</option>
              </select>
              <input
                type="text"
                className="ws-mono"
                value={itemUrl}
                placeholder={t("workspace.create.itemPlaceholder")}
                spellCheck={false}
                disabled={props.busy}
                aria-invalid={badItem}
                onChange={(e) => setItemUrl(e.target.value)}
              />
            </div>
          </div>
        </div>
        {(badItem || error) && (
          <p className="error-text" role="alert">
            {badItem ? t("error.bad_item") : error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onCancel}>
            {t("dialog.cancel")}
          </button>
          <Button type="submit" disabled={props.busy || badItem}>
            {t("dialog.save")}
          </Button>
        </div>
      </form>
    </dialog>
  );
}
