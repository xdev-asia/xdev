import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, CrashReport } from "@/api";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { CrashDialog } from "./CrashDialog";
import { onCrashOpen } from "./crashEvents";

/**
 * Owns the crash dialog. Opens it for the pending report of the last run (once), for a new boundary
 * report, and on demand (palette, Settings) with the latest report of any status.
 */
export function CrashHost(props: { api: Pick<Api, "crashTakePending" | "crashLatest" | "crashDismiss"> }): JSX.Element {
  const { api } = props;
  const [shown, setShown] = useState<{ report: CrashReport | null } | null>(null);

  useEffect(() => {
    let live = true;
    // `crashTakePending` marks the report dismissed as it hands it out, so this prompts once.
    void api
      .crashTakePending()
      .then((report) => live && report && setShown({ report }))
      .catch(() => {});
    const off = onCrashOpen((open) => {
      if ("report" in open) {
        setShown({ report: open.report });
        return;
      }
      void api
        .crashLatest()
        .then((report) => live && setShown({ report }))
        .catch(() => live && setShown({ report: null }));
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);

  const close = () => {
    const report = shown?.report;
    setShown(null);
    if (report) void api.crashDismiss(report.id).catch(() => {});
  };

  return (
    <SurfaceBoundary id="modal.crash" surface="Crash dialog" report={false} titleKey="boundary.modal.title" bodyKey="boundary.modal.body">
      <CrashDialog open={shown !== null} report={shown?.report ?? null} onClose={close} />
    </SurfaceBoundary>
  );
}
