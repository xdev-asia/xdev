import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import { PROVIDERS, toApiError, type Api, type ApiError, type Matched, type Models, type RouteRule } from "@/api";
import { useI18n } from "@/i18n";
import {
  BLANK_EDIT,
  DEFAULT_EDIT,
  fromRow,
  fromTarget,
  keyTarget,
  move,
  savedRouting,
  tableProblem,
  targetText,
  toTarget,
  type EditRow,
} from "@/orchestration/pipeline/routingTable";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { ROLES } from "./SquadsView";

// A single-agent task is routed as the `task` role.
const RULE_ROLES: readonly string[] = [...ROLES, "task"];
const BLANK: RouteRule = { role: null, provider: null, maxPrompt: null, model: "" };

/** A match-table row with a stable id, so a row keeps its focus and its field ids when it moves. */
interface Item {
  uid: number;
  edit: EditRow;
}

/** Puts focus back on a control after a reorder has been drawn. */
function focusLater(id: string) {
  if (typeof document === "undefined") return;
  setTimeout(() => document.getElementById(id)?.focus(), 0);
}

const sameEdit = (a: EditRow, b: EditRow) => a.agent === b.agent && a.model === b.model && a.pool === b.pool;

/** What the rule's provider offers; a rule for any provider gets both lists. */
function choices(models: Models | undefined, provider: string | null): string[] {
  if (!models) return [];
  if (provider === "claude") return models.claude;
  if (provider === "codex") return models.codex;
  return [...models.claude, ...models.codex];
}

export function RoutingRules({ api }: { api: Api }) {
  const { t } = useI18n();
  const [rules, setRules] = useState<RouteRule[]>();
  const [problem, setProblem] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [models, setModels] = useState<Models>();
  // The match table: kinds of work mapped to an agent, first match wins, with a default row.
  const [table, setTable] = useState<Item[]>([]);
  const [fallback, setFallback] = useState<EditRow>({ ...DEFAULT_EDIT });
  const [stored, setStored] = useState({ table: false, fallback: false });
  const [tableNote, setTableNote] = useState<"agent" | "condition" | null>(null);
  const [sentence, setSentence] = useState("");
  const [label, setLabel] = useState("");
  const [result, setResult] = useState<Matched>();

  useEffect(() => {
    let disposed = false;
    api.routing().then(r => {
      if (disposed) return;
      setRules(r.rules);
      setTable((r.table ?? []).map((row, i) => ({ uid: i + 1, edit: fromRow(row) })));
      setFallback(fromTarget(r.fallback));
      setStored({ table: r.table !== undefined, fallback: r.fallback !== undefined });
    }, e => { if (!disposed) setProblem(toApiError(e)); });
    return () => { disposed = true; };
  }, [api]);
  // Asking the CLIs is slow and optional: without a list the field still takes a typed name.
  useEffect(() => {
    let disposed = false;
    api.models().then(m => { if (!disposed) setModels(m); }, () => {});
    return () => { disposed = true; };
  }, [api]);

  function edit(next: RouteRule[]) {
    setRules(next);
    setSaved(false);
    setResult(undefined);
  }
  function editTable(next: Item[]) {
    setTable(next);
    setSaved(false);
    setTableNote(null);
    setResult(undefined);
  }
  function changeRow(uid: number, patch: Partial<EditRow>) {
    editTable(table.map(item => item.uid === uid ? { ...item, edit: { ...item.edit, ...patch } } : item));
  }
  function moveRow(from: number, to: number, focus: string) {
    editTable(move(table, from, to));
    focusLater(focus);
  }
  function changeFallback(patch: Partial<EditRow>) {
    setFallback({ ...fallback, ...patch });
    setSaved(false);
    setResult(undefined);
  }
  // Writes the fallback only when the person has one: a file made before stays as it was.
  const savedFallback = stored.fallback || table.length > 0 || !sameEdit(fallback, DEFAULT_EDIT) ? fallback : null;
  async function test() {
    if (!rules) return;
    setProblem(undefined);
    try {
      setResult(await api.routingMatch(savedRouting(rules, table.map(i => i.edit), savedFallback, stored.table), sentence, label.trim() === "" ? null : label.trim()));
    } catch (e) {
      setProblem(toApiError(e));
    }
  }
  function change(index: number, patch: Partial<RouteRule>) {
    edit((rules ?? []).map((r, i) => i === index ? { ...r, ...patch } : r));
  }
  function moveUp(index: number) {
    const next = [...(rules ?? [])];
    [next[index - 1], next[index]] = [next[index], next[index - 1]];
    edit(next);
  }
  async function save() {
    if (!rules) return;
    if (rules.some(r => !r.model.trim())) {
      setProblem({ code: "empty_text" });
      return;
    }
    const note = tableProblem(table.map(i => i.edit), savedFallback);
    if (note) {
      setTableNote(note);
      return;
    }
    setBusy(true);
    setProblem(undefined);
    try {
      await api.setRouting(savedRouting(rules, table.map(i => i.edit), savedFallback, stored.table));
      setStored({ table: stored.table || table.length > 0, fallback: stored.fallback || savedFallback !== null });
      setSaved(true);
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
    }
  }
  function row(rule: RouteRule, index: number) {
    const label = t("routing.rule", { n: index + 1 });
    return <div className="routing-rule" key={index} role="group" aria-label={label}>
      <span className="routing-index" aria-hidden="true">{index + 1}</span>
      <label>{t("routing.role")}<select value={rule.role ?? ""} disabled={busy} onChange={e => change(index, { role: e.target.value || null })}>
        <option value="">{t("routing.any")}</option>
        {RULE_ROLES.map(r => <option key={r} value={r}>{r === "task" ? t("routing.task") : t(`squads.role.${r}`)}</option>)}
      </select></label>
      <label>{t("routing.provider")}<select value={rule.provider ?? ""} disabled={busy} onChange={e => change(index, { provider: e.target.value || null })}>
        <option value="">{t("routing.any")}</option>
        {PROVIDERS.map(p => <option key={p} value={p}>{t(`accounts.provider.${p}`)}</option>)}
      </select></label>
      <label>{t("routing.maxPrompt")}<input type="number" min={1} value={rule.maxPrompt ?? ""} placeholder={t("routing.anyLength")} disabled={busy}
        onChange={e => { const n = Number.parseInt(e.target.value, 10); change(index, { maxPrompt: Number.isFinite(n) && n > 0 ? n : null }); }} /></label>
      <label className="routing-model">{t("routing.model")}<input value={rule.model} placeholder={t("routing.modelHint")} disabled={busy} spellCheck={false}
        list={`routing-models-${index}`} onChange={e => change(index, { model: e.target.value })} /></label>
      <datalist id={`routing-models-${index}`}>{choices(models, rule.provider).map(m => <option key={m} value={m} />)}</datalist>
      <div className="routing-actions">
        <button type="button" className="btn-secondary" disabled={busy || index === 0} aria-label={t("routing.upLabel", { n: index + 1 })} onClick={() => moveUp(index)}>{t("routing.up")}</button>
        <button type="button" className="btn-secondary" disabled={busy} aria-label={t("routing.removeLabel", { n: index + 1 })} onClick={() => edit((rules ?? []).filter((_, i) => i !== index))}>{t("routing.remove")}</button>
      </div>
    </div>;
  }
  function agentSelect(id: string, value: string, onChange: (agent: string) => void) {
    return <select id={id} value={value} disabled={busy} onChange={e => onChange(e.target.value)}>
      {value !== "" && !PROVIDERS.some(p => p === value) && <option value={value}>{value}</option>}
      {PROVIDERS.map(p => <option key={p} value={p}>{t(`accounts.provider.${p}`)}</option>)}
    </select>;
  }
  function tableRow(item: Item, index: number) {
    const n = index + 1;
    const id = (part: string) => `routing-row-${item.uid}-${part}`;
    const e = item.edit;
    const hit = result?.row === index;
    return <div className="routing-rule" key={item.uid} role="group" aria-label={t("routing.row", { n })} data-hit={hit ? "true" : undefined}
      onKeyDown={ev => {
        const to = keyTarget(ev.key, ev.altKey, index, table.length);
        if (to === null) return;
        ev.preventDefault();
        moveRow(index, to, (ev.target as HTMLElement).id);
      }}>
      <span className="routing-index" aria-hidden="true">{n}</span>
      <label className="routing-model">{t("routing.keywords")}<input id={id("keywords")} value={e.keywords} placeholder={t("routing.keywordsHint")} disabled={busy} spellCheck={false}
        onChange={ev => changeRow(item.uid, { keywords: ev.target.value })} /></label>
      <label>{t("routing.label")}<input id={id("label")} value={e.label} placeholder={t("routing.labelHint")} disabled={busy} spellCheck={false}
        onChange={ev => changeRow(item.uid, { label: ev.target.value })} /></label>
      <label>{t("routing.agent")}{agentSelect(id("agent"), e.agent, agent => changeRow(item.uid, { agent }))}</label>
      <label className="routing-model">{t("routing.model")}<input id={id("model")} value={e.model} placeholder={t("routing.modelHint")} disabled={busy} spellCheck={false}
        list={`routing-row-models-${item.uid}`} onChange={ev => changeRow(item.uid, { model: ev.target.value })} /></label>
      <datalist id={`routing-row-models-${item.uid}`}>{choices(models, e.agent).map(m => <option key={m} value={m} />)}</datalist>
      <label>{t("routing.pool")}<input id={id("pool")} value={e.pool} placeholder={t("routing.poolHint")} disabled={busy} spellCheck={false}
        onChange={ev => changeRow(item.uid, { pool: ev.target.value })} /></label>
      <div className="routing-actions">
        <button type="button" id={id("up")} className="btn-secondary" disabled={busy || index === 0} aria-label={t("routing.rowUpLabel", { n })} onClick={() => moveRow(index, index - 1, id("up"))}>{t("routing.up")}</button>
        <button type="button" id={id("down")} className="btn-secondary" disabled={busy || index === table.length - 1} aria-label={t("routing.rowDownLabel", { n })} onClick={() => moveRow(index, index + 1, id("down"))}>{t("routing.down")}</button>
        <button type="button" className="btn-secondary" disabled={busy} aria-label={t("routing.rowRemoveLabel", { n })} onClick={() => editTable(table.filter(x => x.uid !== item.uid))}>{t("routing.remove")}</button>
      </div>
    </div>;
  }
  function tableSection() {
    const nextUid = table.reduce((max, i) => Math.max(max, i.uid), 0) + 1;
    return <div className="routing-table" role="group" aria-labelledby="routing-table-title">
      <h3 id="routing-table-title" className="account-section-title">{t("routing.table.title")}</h3>
      <p className="routing-hint">{t("routing.table.hint")}</p>
      {table.length === 0 ? <p className="routing-empty">{t("routing.table.empty")}</p> : <div className="routing-rules">{table.map(tableRow)}</div>}
      <div className="routing-rule" role="group" aria-label={t("routing.default")} data-hit={result && result.row === null ? "true" : undefined}>
        <span className="routing-index" aria-hidden="true">{t("routing.defaultMark")}</span>
        <label>{t("routing.agent")}{agentSelect("routing-default-agent", fallback.agent, agent => changeFallback({ agent }))}</label>
        <label className="routing-model">{t("routing.model")}<input id="routing-default-model" value={fallback.model} placeholder={t("routing.modelHint")} disabled={busy} spellCheck={false}
          list="routing-default-models" onChange={ev => changeFallback({ model: ev.target.value })} /></label>
        <datalist id="routing-default-models">{choices(models, fallback.agent).map(m => <option key={m} value={m} />)}</datalist>
        <label>{t("routing.pool")}<input id="routing-default-pool" value={fallback.pool} placeholder={t("routing.poolHint")} disabled={busy} spellCheck={false}
          onChange={ev => changeFallback({ pool: ev.target.value })} /></label>
      </div>
      {tableNote && <p role="alert" className="routing-problem">{t(`routing.table.problem.${tableNote}`)}</p>}
      <div className="routing-footer">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => { editTable([...table, { uid: nextUid, edit: { ...BLANK_EDIT } }]); focusLater(`routing-row-${nextUid}-keywords`); }}>{t("routing.table.add")}</button>
        <span className="routing-hint">{t("routing.table.keys")}</span>
      </div>
      <form className="routing-test" aria-label={t("routing.test.title")} onSubmit={ev => { ev.preventDefault(); void test(); }}>
        <label className="routing-model">{t("routing.test.sentence")}<input value={sentence} placeholder={t("routing.test.hint")} disabled={busy} onChange={ev => { setSentence(ev.target.value); setResult(undefined); }} /></label>
        <label>{t("routing.label")}<input value={label} placeholder={t("routing.labelHint")} disabled={busy} spellCheck={false} onChange={ev => { setLabel(ev.target.value); setResult(undefined); }} /></label>
        <button type="submit" className="btn-secondary" disabled={busy || sentence.trim() === ""}>{t("routing.test.run")}</button>
      </form>
      <p role="status" className="routing-match">{result
        ? result.row === null
          ? t("routing.test.default", { target: targetText(toTarget(fromTarget(result.target))) })
          : t("routing.test.row", { n: result.row + 1, target: targetText(toTarget(fromTarget(result.target))) })
        : ""}</p>
    </div>;
  }
  return <section className="routing" aria-labelledby="routing-title">
    <h2 id="routing-title" className="account-section-title">{t("routing.title")}</h2>
    <p className="routing-hint">{t("routing.hint")}</p>
    {problem && <ProblemNote problem={problem} />}
    {rules === undefined ? !problem && <p className="placeholder">{t("accounts.loading")}</p> : <>
      {rules.length === 0 ? <p className="routing-empty">{t("routing.empty")}</p> : <div className="routing-rules">{rules.map(row)}</div>}
      <div className="routing-footer">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => edit([...rules, { ...BLANK }])}>{t("routing.add")}</button>
      </div>
      {tableSection()}
      <div className="routing-footer">
        <Button variant="primary" type="button" style={COMPACT} disabled={busy} onClick={save}>{t("routing.save")}</Button>
        {saved && <span role="status" className="routing-saved">{t("routing.saved")}</span>}
      </div>
    </>}
  </section>;
}
