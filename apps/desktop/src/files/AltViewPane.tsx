import type { JSX, ReactNode } from "react";
import { Segmented } from "@xdev-asia/ui";
import { useI18n } from "@/i18n";
import { viewMode } from "./viewMode";

/**
 * A file with a read-only view (table, notebook) and the code editor behind it: a switch between the
 * two. `view` is what the file opens in; "Open as text" shows `editor`.
 */
export function AltViewPane(props: { worktree: string; rel: string; label: string; asText: boolean; view: ReactNode; editor: ReactNode }): JSX.Element {
  const { worktree, rel, label, asText, view, editor } = props;
  const { t } = useI18n();
  return (
    <div className="md-pane">
      <div className="md-pane-bar">
        <Segmented
          label={t("files.altView.switch")}
          value={asText ? "text" : "view"}
          options={[
            { value: "view", label },
            { value: "text", label: t("files.altView.text") },
          ]}
          onChange={(value) => viewMode.set(worktree, rel, value === "text")}
        />
      </div>
      <div className="md-pane-body">{asText ? editor : view}</div>
    </div>
  );
}
