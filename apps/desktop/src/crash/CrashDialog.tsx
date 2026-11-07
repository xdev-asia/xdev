import { Button, CodeBlock, Textarea } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import type { CrashReport } from "@/api";
import { useI18n } from "@/i18n";
import { copyText as writeClipboard } from "@/ui/clipboard";
import { pushToast } from "@/workspace/toastStore";
import { crashCopyText, crashSummary, MAX_NOTES } from "./copyText";

/** The title for a report: a panic closed the app, a boundary report is a UI error, none is "No crash report". */
export function crashTitleKey(report: CrashReport | null): string {
  if (!report) return "crash.title.none";
  return report.source === "renderer" ? "crash.title.boundary" : "crash.title.panic";
}

/** A native modal: focus trapping and Escape come from the browser. Esc and Close both dismiss the report. */
export function CrashDialog(props: {
  open: boolean;
  report: CrashReport | null;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const dialog = useRef<HTMLDialogElement>(null);
  const [notes, setNotes] = useState("");
  const { report } = props;

  useEffect(() => {
    const d = dialog.current;
    if (!d) return;
    if (props.open && !d.open) d.showModal();
    if (!props.open && d.open) d.close();
  }, [props.open]);

  // A new report starts with empty notes.
  useEffect(() => setNotes(""), [report?.id]);

  const text = crashCopyText({ report, notes });
  const copy = async () => {
    const ok = await writeClipboard(text);
    pushToast({ text: t(ok ? "crash.copied" : "crash.copyFailed") });
  };
  const summary = report ? crashSummary(report) : null;

  return (
    <dialog
      ref={dialog}
      className="dialog crash-dialog"
      aria-labelledby="crash-title"
      onCancel={(e) => {
        e.preventDefault();
        props.onClose();
      }}
    >
      <h2 id="crash-title" className="dialog-title">
        {t(crashTitleKey(report))}
      </h2>
      <p className="dialog-body">{t(report ? "crash.body" : "crash.body.none")}</p>
      {summary && (
        <p className="crash-summary">
          <strong>{summary.what}</strong>
          <span>{summary.where}</span>
        </p>
      )}
      <div className="crash-section">
        <span className="crash-label">{t("crash.text.label")}</span>
        <CodeBlock className="crash-code" code={text} labels={{ copy: t("crash.code.copy"), copied: t("crash.code.copied") }} />
      </div>
      <Textarea
        label={t("crash.notes.label")}
        hint={t("crash.notes.count", { count: notes.length, max: MAX_NOTES })}
        value={notes}
        maxLength={MAX_NOTES}
        rows={3}
        onChange={(e) => setNotes(e.target.value)}
      />
      <div className="dialog-actions">
        <Button variant="secondary" type="button" onClick={props.onClose}>
          {t("crash.close")}
        </Button>
        <Button variant="primary" type="button" onClick={() => void copy()}>
          {t("crash.copy")}
        </Button>
      </div>
    </dialog>
  );
}
