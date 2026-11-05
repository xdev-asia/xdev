import { Dialog } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { useI18n } from "@/i18n";
import { MERGE_MAX_BYTES, mergeOutput, type Merged } from "./mergeOutput";

/** A tab to merge: its id, and the title and agent its section is headed by. */
export interface MergeSource {
  id: string;
  title: string;
  agent: string;
}

/** Lines read from each tab; the size cap decides what stays. */
export const MERGE_READ_LINES = 20_000;

/** The merged output of the selected tabs in one plain-text document, to copy or save. */
export function MergeDialog(props: { api: Pick<Api, "termTailRead" | "transcriptSave">; sources: MergeSource[]; onClose(): void }): JSX.Element {
  const { api, sources, onClose } = props;
  const { t } = useI18n();
  const [merged, setMerged] = useState<Merged | null>(null);
  const [status, setStatus] = useState("");

  useEffect(() => {
    let live = true;
    Promise.all(
      sources.map(async (s) => ({
        title: s.title,
        agent: s.agent,
        text: await api.termTailRead(s.id, MERGE_READ_LINES).catch(() => ""),
      })),
    ).then((parts) => live && setMerged(mergeOutput(parts)));
    return () => {
      live = false;
    };
  }, [api, sources]);

  const empty = merged !== null && merged.tabs === 0;

  async function copy(): Promise<void> {
    if (!merged || empty) return;
    try {
      await navigator.clipboard.writeText(merged.text);
      setStatus(t("merge.copied"));
    } catch {
      setStatus(t("merge.failed"));
    }
  }

  async function save(): Promise<void> {
    if (!merged || empty) return;
    try {
      const path = await api.transcriptSave("merged-output", merged.text);
      setStatus(path === null ? "" : t("merge.saved", { path }));
    } catch {
      setStatus(t("merge.failed"));
    }
  }

  return (
    <Dialog
      modal
      size="wide"
      body="plain"
      title={t("merge.title")}
      confirmLabel={t("merge.copy")}
      cancelLabel={t("merge.close")}
      confirmDisabled={merged === null || empty}
      onConfirm={() => void copy()}
      onCancel={onClose}
    >
      <div data-merge>
        <p className="settings-hint">{merged === null ? t("merge.loading") : empty ? t("merge.empty") : t("merge.hint", { count: merged.tabs })}</p>
        {merged && !empty && (
          <pre className="merge-pre" tabIndex={0} aria-label={t("merge.preview")}>
            {merged.text}
          </pre>
        )}
        <div className="merge-actions">
          <button type="button" className="btn-secondary" disabled={merged === null || empty} onClick={() => void save()}>
            {t("merge.save")}
          </button>
        </div>
        <p role="status" className="settings-hint">
          {merged?.cut ? `${t("merge.cut", { size: MERGE_MAX_BYTES / (1024 * 1024) })} ` : ""}
          {status}
        </p>
      </div>
    </Dialog>
  );
}
