import { Button, Field, IconButton, Segmented, Select, Tag, Textarea } from "@xdev-asia/ui";
import { useState } from "react";
import type { DragEvent, JSX } from "react";
import type { Chart, ChartKind, ChartSeat } from "@/api";
import { useI18n } from "@/i18n";
import { CHART_KINDS, SEATS_MAX, addRoute, addSeat, chartProblems, moveSeat, removeRoute, removeSeat, seatLabel, setKind, setLead, updateRoute, updateSeat } from "./chartModel";
import { ChartPreview } from "./ChartPreview";

/** An agent a seat may start. `models` empty: the model is typed. */
export interface ChartAgent {
  id: string;
  name: string;
  models: string[];
}

export interface ChartEditorProps {
  chart: Chart;
  onChange(chart: Chart): void;
  agents: ChartAgent[];
}

/** Name, kind, the seats (add, remove, reorder by keyboard or drag), the kind's own fields, and a live preview. */
export function ChartEditor({ chart, onChange, agents }: ChartEditorProps): JSX.Element {
  const { t } = useI18n();
  const [dragging, setDragging] = useState<number | null>(null);
  const [said, setSaid] = useState("");
  const label = (seat: ChartSeat, i: number) => seatLabel(seat, i, t);
  const problems = chartProblems(chart);
  const lead = chart.seats.find((s) => s.lead);
  const seatOptions = chart.seats.map((s, i) => ({ value: s.id, label: label(s, i) }));
  const firstAgent = agents[0]?.id;

  function move(from: number, to: number): void {
    if (to < 0 || to >= chart.seats.length || from === to) return;
    const seat = chart.seats[from];
    onChange(moveSeat(chart, from, to));
    setSaid(t("charts.seat.moved", { name: label(seat, from), n: to + 1 }));
  }
  function add(): void {
    onChange(addSeat(chart, firstAgent));
    setSaid(t("charts.seat.added", { n: chart.seats.length + 1 }));
  }
  function remove(seat: ChartSeat, i: number): void {
    onChange(removeSeat(chart, seat.id));
    setSaid(t("charts.seat.removed", { name: label(seat, i) }));
  }
  function kind(next: string): void {
    if (!CHART_KINDS.includes(next as ChartKind)) return;
    onChange(setKind(chart, next as ChartKind));
    setSaid(t("charts.kind.changed", { kind: t(`charts.kind.${next}`) }));
  }
  const onDrop = (e: DragEvent<HTMLLIElement>, to: number) => {
    e.preventDefault();
    if (dragging !== null) move(dragging, to);
    setDragging(null);
  };

  function agentField(seat: ChartSeat, i: number): JSX.Element {
    const known = agents.some((a) => a.id === seat.agent);
    const options = [...agents.map((a) => ({ value: a.id, label: a.name })), ...(known || seat.agent === "" ? [] : [{ value: seat.agent, label: seat.agent }])];
    return (
      <label className="charts-field">
        <span className="charts-label">{t("charts.seat.agent")}</span>
        <Select aria-label={t("charts.seat.agentOf", { name: label(seat, i) })} value={seat.agent} options={options} onChange={(e) => onChange(updateSeat(chart, seat.id, { agent: e.target.value, model: null }))} />
      </label>
    );
  }
  function modelField(seat: ChartSeat, i: number): JSX.Element {
    const models = agents.find((a) => a.id === seat.agent)?.models ?? [];
    const set = (v: string) => onChange(updateSeat(chart, seat.id, { model: v.trim() === "" ? null : v }));
    if (models.length === 0) {
      return <Field label={t("charts.seat.model")} hint={t("charts.seat.modelHint")} value={seat.model ?? ""} aria-label={t("charts.seat.modelOf", { name: label(seat, i) })} onChange={(e) => set(e.target.value)} />;
    }
    const options = [{ value: "", label: t("charts.seat.modelDefault") }, ...models.map((m) => ({ value: m, label: m })), ...(seat.model && !models.includes(seat.model) ? [{ value: seat.model, label: seat.model }] : [])];
    return (
      <label className="charts-field">
        <span className="charts-label">{t("charts.seat.model")}</span>
        <Select aria-label={t("charts.seat.modelOf", { name: label(seat, i) })} value={seat.model ?? ""} options={options} onChange={(e) => set(e.target.value)} />
      </label>
    );
  }

  return (
    <div className="charts-editor">
      <Field label={t("charts.name")} value={chart.name} maxLength={80} placeholder={t("charts.namePlaceholder")} onChange={(e) => onChange({ ...chart, name: e.target.value })} />
      <div className="charts-kind">
        <span className="charts-label" aria-hidden="true">
          {t("charts.kind")}
        </span>
        <Segmented label={t("charts.kind")} value={chart.kind} onChange={kind} options={CHART_KINDS.map((k) => ({ value: k, label: t(`charts.kind.${k}`) }))} />
        <p className="charts-muted">{t(`charts.kind.${chart.kind}.hint`)}</p>
        {chart.kind !== "pipeline" && chart.seats.length > 0 ? (
          <label className="charts-field">
            <span className="charts-label">{t(chart.kind === "router" ? "charts.dispatcher" : "charts.lead")}</span>
            <Select aria-label={t(chart.kind === "router" ? "charts.dispatcher" : "charts.lead")} value={lead?.id ?? ""} options={seatOptions} onChange={(e) => onChange(setLead(chart, e.target.value))} />
          </label>
        ) : null}
      </div>

      <section className="charts-section" aria-labelledby="charts-seats-title">
        <h3 className="charts-heading" id="charts-seats-title">
          {t("charts.seats", { n: chart.seats.length })}
        </h3>
        <p className="charts-muted">{t("charts.seats.hint")}</p>
        <ol className="charts-seats">
          {chart.seats.map((seat, i) => {
            const name = label(seat, i);
            return (
              <li
                key={seat.id}
                className="charts-seat"
                aria-label={name}
                data-dragging={dragging === i ? "true" : undefined}
                draggable
                onDragStart={(e) => {
                  setDragging(i);
                  e.dataTransfer.effectAllowed = "move";
                  e.dataTransfer.setData("text/plain", seat.id);
                }}
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => onDrop(e, i)}
                onDragEnd={() => setDragging(null)}
              >
                <div className="charts-seat-head">
                  <span className="charts-seat-n" aria-hidden="true">
                    {i + 1}
                  </span>
                  <span className="charts-seat-name">{name}</span>
                  {seat.lead && chart.kind !== "pipeline" ? <Tag>{t(chart.kind === "router" ? "charts.dispatcher" : "charts.lead")}</Tag> : null}
                  <span className="charts-seat-tools">
                    <IconButton icon="arrow-up" type="button" label={t("charts.seat.up", { name })} disabled={i === 0} onClick={() => move(i, i - 1)} />
                    <IconButton icon="arrow-down" type="button" label={t("charts.seat.down", { name })} disabled={i === chart.seats.length - 1} onClick={() => move(i, i + 1)} />
                    <IconButton icon="trash" type="button" label={t("charts.seat.remove", { name })} disabled={chart.seats.length === 1} onClick={() => remove(seat, i)} />
                  </span>
                </div>
                <div className="charts-seat-grid">
                  <Field label={t("charts.seat.role")} value={seat.role} placeholder={t("charts.seat.rolePlaceholder")} aria-label={t("charts.seat.roleOf", { n: i + 1 })} onChange={(e) => onChange(updateSeat(chart, seat.id, { role: e.target.value }))} />
                  {agentField(seat, i)}
                  {modelField(seat, i)}
                </div>
                <Textarea label={t("charts.seat.prompt")} rows={2} value={seat.prompt} aria-label={t("charts.seat.promptOf", { name })} onChange={(e) => onChange(updateSeat(chart, seat.id, { prompt: e.target.value }))} />
              </li>
            );
          })}
        </ol>
        <div>
          <Button variant="secondary" type="button" icon="plus" disabled={chart.seats.length >= SEATS_MAX} onClick={add}>
            {t("charts.seat.add")}
          </Button>
        </div>
      </section>

      {chart.kind === "router" ? (
        <section className="charts-section" aria-labelledby="charts-routes-title">
          <h3 className="charts-heading" id="charts-routes-title">
            {t("charts.routes")}
          </h3>
          <p className="charts-muted">{t("charts.routes.hint")}</p>
          {chart.routes.length > 0 ? (
            <ul className="charts-routes">
              {chart.routes.map((r, i) => (
                <li key={i} className="charts-route">
                  <Field label={t("charts.route.kind")} value={r.kind} placeholder={t("charts.route.kindPlaceholder")} onChange={(e) => onChange(updateRoute(chart, i, { kind: e.target.value }))} />
                  <label className="charts-field">
                    <span className="charts-label">{t("charts.route.seat")}</span>
                    <Select aria-label={t("charts.route.seatOf", { n: i + 1 })} value={r.seat} options={seatOptions} onChange={(e) => onChange(updateRoute(chart, i, { seat: e.target.value }))} />
                  </label>
                  <IconButton icon="trash" type="button" label={t("charts.route.remove", { n: i + 1 })} onClick={() => onChange(removeRoute(chart, i))} />
                </li>
              ))}
            </ul>
          ) : null}
          <div>
            <Button variant="secondary" type="button" icon="plus" onClick={() => onChange(addRoute(chart))}>
              {t("charts.route.add")}
            </Button>
          </div>
        </section>
      ) : null}

      <ChartPreview chart={chart} />
      {problems.length > 0 ? (
        <p className="charts-problem" id="charts-problem">
          {t(`charts.problem.${problems[0]}`)}
        </p>
      ) : null}
      <p className="x-sr-only" role="status">
        {said}
      </p>
    </div>
  );
}
