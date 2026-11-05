import { useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { IconButton, Segmented } from "@xdev-asia/ui";
import type { Api } from "@/api";
import type { Heading } from "@/doc/markdownRich";
import { useI18n } from "@/i18n";
import { markdownMode, useMarkdownMode } from "./markdownMode";
import { MarkdownPreview } from "./MarkdownPreview";
import { Toc } from "./Toc";
import { scrollToHeading } from "./tocModel";

/** A Markdown file tab: the editor (`source`) or its rendered preview, one at a time. */
export function MarkdownPane(props: { api: Api; worktree: string; rel: string; text: string; source: ReactNode }): JSX.Element {
  const { api, worktree, rel, text, source } = props;
  const { t } = useI18n();
  const mode = useMarkdownMode(worktree, rel);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [tocOpen, setTocOpen] = useState(false);
  const main = useRef<HTMLDivElement>(null);
  const preview = mode === "preview";
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
        <IconButton
          icon="list"
          label={t("files.preview.toc")}
          title={preview ? t("files.preview.toc") : t("files.preview.tocDisabled")}
          aria-pressed={preview && tocOpen}
          disabled={!preview}
          onClick={() => setTocOpen(!tocOpen)}
        />
      </div>
      <div className={preview && tocOpen ? "md-pane-body md-split" : "md-pane-body"}>
        {preview ? (
          <>
            <div className="md-pane-main" ref={main}>
              <MarkdownPreview api={api} worktree={worktree} rel={rel} text={text} onHeadings={setHeadings} />
            </div>
            {tocOpen && <Toc headings={headings} onPick={(id) => main.current && scrollToHeading(main.current, id)} />}
          </>
        ) : (
          source
        )}
      </div>
    </div>
  );
}
