import type { JSX, ReactNode } from "react";
import { Segmented } from "@xdev-asia/ui";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { markdownMode, useMarkdownMode } from "./markdownMode";
import { MarkdownPreview } from "./MarkdownPreview";

/** A Markdown file tab: the editor (`source`) or its rendered preview, one at a time. */
export function MarkdownPane(props: { api: Api; worktree: string; rel: string; text: string; source: ReactNode }): JSX.Element {
  const { api, worktree, rel, text, source } = props;
  const { t } = useI18n();
  const mode = useMarkdownMode(worktree, rel);
  return (
    <div className="md-pane">
      <div className="md-pane-bar">
        <Segmented
          label={t("files.preview.mode")}
          value={mode}
          options={[
            { value: "source", label: t("files.preview.source") },
            { value: "preview", label: t("files.preview.preview") },
          ]}
          onChange={(value) => markdownMode.set(worktree, rel, value === "preview" ? "preview" : "source")}
        />
      </div>
      <div className="md-pane-body">
        {mode === "preview" ? <MarkdownPreview api={api} worktree={worktree} rel={rel} text={text} /> : source}
      </div>
    </div>
  );
}
