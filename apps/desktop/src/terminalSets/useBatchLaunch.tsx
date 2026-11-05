import { Button } from "@xdev-asia/ui";
import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { useI18n } from "@/i18n";
import type { Sessions, Tab } from "@/workspace/sessions";
import type { BatchProgress } from "./batch";
import { openMany, type OpenContext } from "./launch";

type Ctx = Pick<OpenContext, "staggerMs" | "graceMs" | "sleep">;

interface Job {
  open(index: number): Tab;
  total: number;
  ctx: Ctx;
}

/**
 * Runs a batch of tab opens with progress, and keeps what failed for "Retry failed". `ui` is the status
 * line (role=status) with its actions; it is null when no batch ran or it was dismissed.
 */
export function useBatchLaunch(sessions: Pick<Sessions, "close">): {
  run(total: number, open: (index: number) => Tab, ctx?: Ctx, indexes?: readonly number[]): Promise<BatchProgress>;
  ui: ReactNode;
} {
  const { t } = useI18n();
  const [progress, setProgress] = useState<BatchProgress | null>(null);
  const [busy, setBusy] = useState(false);
  // Plain holders kept in state: they outlive renders without a ref.
  const [job] = useState(() => ({ current: null as Job | null }));
  const [tabs] = useState(() => ({ current: new Map<number, Tab>() }));
  const [failedBefore] = useState(() => ({ current: [] as number[] }));

  const exec = useCallback(
    async (indexes: readonly number[], j: Job): Promise<BatchProgress> => {
      setBusy(true);
      const keep = failedBefore.current.filter((i) => !indexes.includes(i));
      const merge = (p: BatchProgress): BatchProgress => ({
        tried: j.total - indexes.length + p.tried,
        total: j.total,
        failed: [...new Set([...keep, ...p.failed])].sort((a, b) => a - b),
      });
      const started = openMany(indexes, j.open, { ...j.ctx, onProgress: (p) => setProgress(merge(p)) });
      for (const [i, tab] of started.tabs) tabs.current.set(i, tab);
      const out = merge(await started.done);
      for (const [i, tab] of started.tabs) tabs.current.set(i, tab);
      failedBefore.current = out.failed;
      setProgress(out);
      setBusy(false);
      return out;
    },
    [failedBefore, tabs],
  );

  const run = useCallback(
    (total: number, open: (index: number) => Tab, ctx: Ctx = {}, indexes?: readonly number[]) => {
      const j: Job = { open, total, ctx };
      job.current = j;
      tabs.current = new Map();
      failedBefore.current = [];
      return exec(indexes ?? Array.from({ length: total }, (_, i) => i), j);
    },
    [exec, failedBefore, job, tabs],
  );

  const dropFailed = (failed: readonly number[]) => {
    for (const i of failed) {
      const tab = tabs.current.get(i);
      if (tab) void sessions.close(tab.id);
      tabs.current.delete(i);
    }
  };

  let ui: ReactNode = null;
  if (progress) {
    const { tried, total, failed } = progress;
    const text =
      tried < total || busy
        ? t("terminalSets.batch.progress", { tried, total })
        : failed.length > 0
          ? t("terminalSets.batch.failed", { count: failed.length })
          : t("terminalSets.batch.done", { count: total });
    ui = (
      <div className="ts-progress">
        <span role="status" aria-live="polite">
          {text}
        </span>
        {!busy && failed.length > 0 && (
          <>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                const j = job.current;
                if (!j) return;
                const again = [...failed];
                dropFailed(again);
                void exec(again, j);
              }}
            >
              {t("terminalSets.batch.retry")}
            </Button>
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                dropFailed(failed);
                setProgress(null);
              }}
            >
              {t("terminalSets.batch.closeFailed")}
            </Button>
          </>
        )}
        {!busy && failed.length === 0 && (
          <Button variant="secondary" type="button" onClick={() => setProgress(null)}>
            {t("dialog.close")}
          </Button>
        )}
      </div>
    );
  }
  return { run, ui };
}
