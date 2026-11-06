import { Button, Dialog, EmptyState, ListRow } from "@xdev-asia/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Chart } from "@/api";
import { useI18n } from "@/i18n";
import { ChartEditor, type ChartAgent } from "./ChartEditor";
import { DEFAULT_AGENT, chartProblems, emptyChart, normalize, problemOf } from "./chartModel";
import "./charts.css";

export type ChartsApi = Pick<Api, "chartsList" | "chartsSave" | "chartsDelete" | "chartsDuplicate" | "profiles">;

export interface ChartsDialogProps {
  api: ChartsApi;
  /** A chart to edit first (from a squad or the team map); null opens the list. */
  draft: Chart | null;
  onClose(): void;
  /** Starts the chart's seats as tabs; resolves the words to announce when it did not. */
  onRun(chart: Chart): Promise<string | null>;
}

/** The saved charts (run, edit, duplicate, delete) and the editor. Esc in the editor goes back to the list. */
export function ChartsDialog({ api, draft, onClose, onRun }: ChartsDialogProps): JSX.Element {
  const { t } = useI18n();
  const [charts, setCharts] = useState<Chart[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState<Chart | null>(draft ? normalizeDraft(draft) : null);
  const [agents, setAgents] = useState<ChartAgent[]>([]);
  const [status, setStatus] = useState("");
  const [deleting, setDeleting] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setCharts(await api.chartsList());
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, [api]);

  useEffect(() => {
    void load();
    api
      .profiles()
      .then((v) => setAgents(v.profiles.filter((p) => p.profile.enabled).map((p) => ({ id: p.profile.id, name: p.profile.name, models: p.models }))))
      .catch(() => setAgents([]));
  }, [load, api]);

  const failure = (e: unknown, fallback: string) => {
    const err = toApiError(e);
    const problem = problemOf(err.detail);
    if (problem) return t(`charts.problem.${problem}`);
    return err.detail ? t("charts.failedWith", { detail: err.detail }) : fallback;
  };

  async function save(): Promise<void> {
    if (!editing || busy) return;
    setBusy(true);
    try {
      const saved = await api.chartsSave(editing);
      setEditing(null);
      setStatus(t("charts.saved", { name: saved.name }));
      await load();
    } catch (e) {
      setStatus(failure(e, t("charts.failed")));
    } finally {
      setBusy(false);
    }
  }
  async function duplicate(c: Chart): Promise<void> {
    try {
      const copy = await api.chartsDuplicate(c.id, t("charts.copyName", { name: c.name }));
      setStatus(t("charts.duplicated", { name: copy.name }));
    } catch (e) {
      setStatus(failure(e, t("charts.failed")));
    }
    await load();
  }
  async function remove(c: Chart): Promise<void> {
    if (deleting !== c.id) {
      setDeleting(c.id);
      setStatus(t("charts.deleteConfirmHint", { name: c.name }));
      return;
    }
    setDeleting(null);
    try {
      await api.chartsDelete(c.id);
      setStatus(t("charts.deleted", { name: c.name }));
    } catch (e) {
      setStatus(failure(e, t("charts.failed")));
    }
    await load();
  }
  async function run(c: Chart): Promise<void> {
    setStatus(t("charts.starting", { name: c.name }));
    const why = await onRun(c);
    setStatus(why ?? t("charts.started", { name: c.name, n: c.seats.length }));
  }

  const statusLine = (
    <p className="charts-status" role="status">
      {status}
    </p>
  );

  if (editing) {
    const problems = chartProblems(editing);
    return (
      <Dialog
        modal
        size="wide"
        body="plain"
        title={editing.id ? t("charts.editTitle") : t("charts.newTitle")}
        confirmLabel={t("charts.save")}
        cancelLabel={t("charts.back")}
        confirmDisabled={busy || problems.length > 0}
        onConfirm={() => void save()}
        onCancel={() => {
          setEditing(null);
          setStatus("");
        }}
      >
        <div className="charts-body">
          {statusLine}
          <ChartEditor chart={editing} onChange={setEditing} agents={agents} />
        </div>
      </Dialog>
    );
  }

  const kindWord = (c: Chart) => t(`charts.kind.${c.kind}`);
  return (
    <Dialog modal size="wide" body="plain" title={t("charts.title")} confirmLabel={t("charts.close")} cancelLabel={null} onConfirm={onClose} onCancel={onClose}>
      <div className="charts-body">
        {statusLine}
        <div className="charts-toolbar">
          <Button variant="secondary" type="button" icon="plus" onClick={() => setEditing(emptyChart("", agents[0]?.id ?? DEFAULT_AGENT))}>
            {t("charts.new")}
          </Button>
        </div>
        {failed && charts === null ? (
          <p className="charts-muted">{t("charts.loadFailed")}</p>
        ) : charts === null ? (
          <p className="charts-muted">{t("charts.loading")}</p>
        ) : charts.length === 0 ? (
          <EmptyState size="inline" title={t("charts.empty")} hint={t("charts.emptyHint")} />
        ) : (
          <ul className="charts-list" aria-label={t("charts.title")}>
            {charts.map((c) => (
              <ListRow
                key={c.id}
                as="li"
                className="charts-row"
                title={c.name}
                meta={t("charts.meta", { kind: kindWord(c), n: c.seats.length })}
                onClick={() => setEditing(c)}
                trailing={
                  <span className="charts-row-actions">
                    <Button variant="secondary" type="button" aria-label={t("charts.runLabel", { name: c.name })} onClick={() => void run(c)}>
                      {t("charts.run")}
                    </Button>
                    <Button variant="secondary" type="button" aria-label={t("charts.editLabel", { name: c.name })} onClick={() => setEditing(c)}>
                      {t("charts.edit")}
                    </Button>
                    <Button variant="secondary" type="button" aria-label={t("charts.duplicateLabel", { name: c.name })} onClick={() => void duplicate(c)}>
                      {t("charts.duplicate")}
                    </Button>
                    <Button
                      variant="secondary"
                      type="button"
                      aria-label={t(deleting === c.id ? "charts.deleteConfirmLabel" : "charts.deleteLabel", { name: c.name })}
                      onClick={() => void remove(c)}
                    >
                      {t(deleting === c.id ? "charts.deleteConfirm" : "charts.delete")}
                    </Button>
                  </span>
                }
              />
            ))}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** A draft from outside, with its lead held to one seat. Edges it brought along stay until the seats change. */
function normalizeDraft(draft: Chart): Chart {
  const n = normalize(draft);
  return { ...n, edges: draft.edges.length > 0 ? draft.edges : n.edges };
}
