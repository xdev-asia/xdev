import { Button, IconButton, ListRow, StatusDot, type StatusTone } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type PromptQueueItem, type PromptQueueQuotaFact, type PromptQueueStatus } from "@/api";
import { useI18n } from "@/i18n";
import { paused, preview, toDraft } from "./queue";
import { ScheduleForm } from "./ScheduleForm";
import { whenLabel } from "./whenLabel";

const TONE: Record<PromptQueueStatus, StatusTone> = { waiting: "neutral", sending: "accent", unconfirmed: "warn", failed: "danger", tab_closed: "neutral" };

/** The queued prompts of one tab: reorder, edit, delete, send now; Retry and Skip for a paused one. */
export function QueuePanel(props: {
  api: Api;
  /** The tab's items, in the order they go. */
  items: readonly PromptQueueItem[];
  account: string | null;
  quotas: readonly PromptQueueQuotaFact[];
  onBack(): void;
}): JSX.Element {
  const { api, items } = props;
  const { t } = useI18n();
  const [editing, setEditing] = useState<string | null>(null);
  const [note, setNote] = useState("");

  async function run(job: () => Promise<unknown>, done: string) {
    try {
      await job();
      setNote(done);
    } catch (err) {
      setNote(t(toApiError(err).detail === "busy" ? "composer.queue.busy" : "composer.queue.failed"));
    }
  }

  const item = items.find((i) => i.id === editing);
  if (item) {
    return (
      <div className="composer-templates">
        <ScheduleForm
          account={props.account}
          quotas={props.quotas}
          text={item.text}
          initial={toDraft(item.when, Date.now())}
          confirmLabel={t("composer.queue.save")}
          onCancel={() => setEditing(null)}
          onSubmit={(when, text) => {
            setEditing(null);
            void run(() => api.promptQueueUpdate(item.id, text ?? item.text, when), t("composer.queue.saved"));
          }}
        />
        <p className="composer-status" role="status" />
      </div>
    );
  }

  return (
    <div className="composer-templates">
      {items.length === 0 ? (
        <p className="composer-empty">{t("composer.queue.empty")}</p>
      ) : (
        <ol className="composer-template-list composer-queue" aria-label={t("composer.queue.title")} data-testid="composer-queue">
          {items.map((it, i) => {
            const name = preview(it.text, 40);
            const stopped = paused(it);
            const sending = it.status === "sending";
            return (
              <li key={it.id} className="composer-queue-item" data-status={it.status} data-testid="composer-queue-item">
                <ListRow
                  title={<span className="ws-mono">{preview(it.text)}</span>}
                  meta={whenLabel(it, t)}
                  leading={<StatusDot tone={TONE[it.status]} label={t(`composer.queue.status.${it.status}`)} />}
                />
                <div className="composer-queue-actions">
                  <IconButton icon="arrow-up" label={t("composer.queue.up", { name })} disabled={i === 0 || sending} onClick={() => void run(() => api.promptQueueReorder(it.id, -1), t("composer.queue.moved", { name }))} />
                  <IconButton icon="arrow-down" label={t("composer.queue.down", { name })} disabled={i === items.length - 1 || sending} onClick={() => void run(() => api.promptQueueReorder(it.id, 1), t("composer.queue.moved", { name }))} />
                  <IconButton icon="edit" label={t("composer.queue.edit", { name })} disabled={sending} onClick={() => setEditing(it.id)} />
                  <IconButton icon="trash" label={t("composer.queue.delete", { name })} disabled={sending} onClick={() => void run(() => api.promptQueueDelete(it.id), t("composer.queue.deleted", { name }))} />
                  {stopped ? (
                    <>
                      <Button type="button" variant="secondary" icon="refresh" onClick={() => void run(() => api.promptQueueSendNow(it.id), t("composer.queue.retrying", { name }))}>
                        {t("composer.queue.retry")}
                      </Button>
                      <Button type="button" variant="secondary" onClick={() => void run(() => api.promptQueueDelete(it.id), t("composer.queue.skipped", { name }))}>
                        {t("composer.queue.skip")}
                      </Button>
                    </>
                  ) : (
                    <Button type="button" variant="secondary" icon="send" disabled={sending || it.status === "tab_closed"} onClick={() => void run(() => api.promptQueueSendNow(it.id), t("composer.queue.sendingNow", { name }))}>
                      {t("composer.queue.sendNow")}
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
      <div className="composer-actions">
        <Button type="button" variant="secondary" onClick={props.onBack}>
          {t("composer.templates.back")}
        </Button>
      </div>
      <p className="composer-status" role="status" data-testid="composer-queue-status">
        {note}
      </p>
    </div>
  );
}
