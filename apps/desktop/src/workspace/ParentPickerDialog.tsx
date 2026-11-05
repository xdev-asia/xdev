import { SearchPicker } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { WorktreeView } from "@/api";
import { useI18n } from "@/i18n";

/** The candidates that match `query` on title, name, branch or path, as picker rows. */
export function pickerRows(candidates: WorktreeView[], query: string): { id: string; title: string; meta: string }[] {
  const q = query.trim().toLowerCase();
  return candidates
    .filter((w) => q === "" || [w.title ?? "", w.name, w.branch ?? "", w.path].some((s) => s.toLowerCase().includes(q)))
    .map((w) => ({ id: w.path, title: w.title ?? w.name, meta: w.branch ?? w.path }));
}

/** Pick the parent of a worktree from the candidates. A pick acts at once, so the dialog has no primary button. */
export function ParentPickerDialog(props: {
  worktree: WorktreeView;
  candidates: WorktreeView[];
  onPick(path: string): void;
  onCancel(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [query, setQuery] = useState("");
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
  }, []);
  const items = pickerRows(props.candidates, query);
  return (
    <dialog
      ref={dialog}
      className="dialog ws-dialog"
      aria-labelledby="ws-parent-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onCancel();
      }}
    >
      <h2 id="ws-parent-title" className="dialog-title">
        {t("lineage.picker.title", { name: props.worktree.title ?? props.worktree.name })}
      </h2>
      <SearchPicker
        label={t("lineage.picker.search")}
        placeholder={t("lineage.picker.search")}
        value={query}
        onValueChange={setQuery}
        items={items}
        status={items.length === 0 ? t("lineage.picker.empty") : undefined}
        onPick={props.onPick}
      />
      <div className="dialog-actions">
        <button type="button" className="btn-secondary" onClick={props.onCancel}>
          {t("dialog.cancel")}
        </button>
      </div>
    </dialog>
  );
}
