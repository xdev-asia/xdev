import { useEffect } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { loadFile } from "./fileIO";
import { fileTabs, useFileEntry } from "./fileTabs";

/** One open file. Reads it when it first shows; the editor itself comes with the next task. */
export function FileView(props: { api: Api; worktree: string; rel: string }): JSX.Element {
  const { api, worktree, rel } = props;
  const { t } = useI18n();
  const entry = useFileEntry(worktree, rel);
  const status = entry?.status;
  useEffect(() => {
    if (status === "loading") void loadFile({ api, store: fileTabs, t }, worktree, rel);
  }, [api, worktree, rel, status, t]);
  return (
    <div className="file-view" data-rel={rel}>
      {(!entry || entry.status === "loading") && <p className="ws-empty">{t("files.loading")}</p>}
    </div>
  );
}
