import { Button } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { CompareDialog } from "./CompareDialog";
import { keepMineFile, overwriteFile, reloadWithUndo, type FileIo } from "./fileIO";
import { isDirty, type FileEntry } from "./fileTabs";

/** True while the entry needs a choice: a save met a newer file, or watching found one. */
export const needsChoice = (e: FileEntry): boolean => e.conflict !== null || e.external === "changed";

/**
 * The bar over an editor whose file changed on disk. Overwrite is the one primary action and only
 * shows when there are edits to write; Compare opens the two versions side by side.
 */
export function ExternalChangeBanner(props: { io: FileIo; entry: FileEntry; onCompare(): void }): JSX.Element {
  const { io, entry, onCompare } = props;
  const { t } = useI18n();
  const { worktree, rel } = entry;
  const saveConflict = entry.external === null;
  return (
    <div className="file-conflict" role="alert">
      <span>{t(saveConflict ? "files.conflict.body" : "files.external.body")}</span>
      <button type="button" className="btn-secondary" onClick={onCompare}>{t("files.external.compare")}</button>
      <button type="button" className="btn-secondary" onClick={() => void reloadWithUndo(io, worktree, rel)}>{t("files.external.reload")}</button>
      <button type="button" className="btn-secondary" title={t("files.external.keepHint")} onClick={() => void keepMineFile(io, worktree, rel)}>
        {t("files.external.keep")}
      </button>
      {isDirty(entry) && <Button variant="primary" type="button" onClick={() => void overwriteFile(io, worktree, rel)}>{t("files.conflict.overwrite")}</Button>}
    </div>
  );
}

/** The banner plus the comparison it opens; the open state lives here so the banner stays plain. */
export function ExternalChange(props: { api: Api; entry: FileEntry; io: FileIo }): JSX.Element {
  const { api, entry, io } = props;
  const [comparing, setComparing] = useState(false);
  return (
    <>
      <ExternalChangeBanner io={io} entry={entry} onCompare={() => setComparing(true)} />
      {comparing && (
        <CompareDialog
          api={api}
          worktree={entry.worktree}
          rel={entry.rel}
          current={entry.text}
          onClose={() => setComparing(false)}
          onReload={() => {
            setComparing(false);
            void reloadWithUndo(io, entry.worktree, entry.rel);
          }}
        />
      )}
    </>
  );
}
