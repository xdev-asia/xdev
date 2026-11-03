import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import { PROVIDERS, toApiError, type Api, type ApiError, type Models, type RouteRule } from "@/api";
import { useI18n } from "@/i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { ROLES } from "./SquadsView";

// A single-agent task is routed as the `task` role.
const RULE_ROLES: readonly string[] = [...ROLES, "task"];
const BLANK: RouteRule = { role: null, provider: null, maxPrompt: null, model: "" };

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

  useEffect(() => {
    let disposed = false;
    api.routing().then(r => { if (!disposed) setRules(r.rules); }, e => { if (!disposed) setProblem(toApiError(e)); });
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
    setBusy(true);
    setProblem(undefined);
    try {
      await api.setRouting({ rules: rules.map(r => ({ ...r, model: r.model.trim() })) });
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
  return <section className="routing" aria-labelledby="routing-title">
    <h2 id="routing-title" className="account-section-title">{t("routing.title")}</h2>
    <p className="routing-hint">{t("routing.hint")}</p>
    {problem && <ProblemNote problem={problem} />}
    {rules === undefined ? !problem && <p className="placeholder">{t("accounts.loading")}</p> : <>
      {rules.length === 0 ? <p className="routing-empty">{t("routing.empty")}</p> : <div className="routing-rules">{rules.map(row)}</div>}
      <div className="routing-footer">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => edit([...rules, { ...BLANK }])}>{t("routing.add")}</button>
        <Button type="button" style={COMPACT} disabled={busy} onClick={save}>{t("routing.save")}</Button>
        {saved && <span role="status" className="routing-saved">{t("routing.saved")}</span>}
      </div>
    </>}
  </section>;
}
