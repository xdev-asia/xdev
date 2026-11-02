import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import { PROVIDERS, toApiError, type Account, type Accounts, type Api, type ApiError, type Provider, type Quota } from "../api";
import { useI18n } from "../i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";
import { RoutingRules } from "./RoutingRules";

type State = Quota["state"];
type Filter = "all" | State;
type Bucket = "soon" | "mid" | "late" | "unknown";
const FILTERS: readonly Filter[] = ["all", "ok", "reserve", "full", "unknown"];
const BUCKETS: readonly Bucket[] = ["soon", "mid", "late", "unknown"];
// Usable accounts first; the sort is stable, so the API order breaks ties.
const RANK: Record<State, number> = { ok: 0, reserve: 1, unknown: 2, full: 3 };
// Above this many accounts the table is the default layout.
const TABLE_FROM = 9;

function minutesUntil(at: string | null | undefined): number | null {
  if (!at) return null;
  const time = Date.parse(at);
  return Number.isFinite(time) ? Math.max(0, Math.ceil((time - Date.now()) / 60_000)) : null;
}
function bucketOf(minutes: number | null): Bucket {
  if (minutes === null) return "unknown";
  return minutes < 60 ? "soon" : minutes < 180 ? "mid" : "late";
}
const clamp = (percent: number) => Math.min(100, Math.max(0, percent));

export function AccountsView({ api }: { api: Api }) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Accounts>();
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [problem, setProblem] = useState<ApiError>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [provider, setProvider] = useState<Provider>("claude");
  // null adds a new account; a string imports that existing folder.
  const [folder, setFolder] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [command, setCommand] = useState<string>();
  const [copy, setCopy] = useState<"copied" | "copyFailed">();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [polling, setPolling] = useState<Record<string, number>>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  // null follows the account count; a click pins the choice.
  const [layout, setLayout] = useState<"table" | "cards" | null>(null);

  useEffect(() => {
    let disposed = false;
    let loading = false;
    async function load() {
      if (loading) return;
      loading = true;
      try {
        const [next, usage] = await Promise.all([api.accounts(), api.quota()]);
        if (!disposed) {
          setAccounts(next);
          setQuotas(usage);
        }
      } catch (e) {
        if (!disposed) setProblem(toApiError(e));
      } finally {
        loading = false;
      }
    }
    void load();
    const timer = setInterval(() => void load(), 300_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, revision]);

  useEffect(() => {
    if (Object.keys(polling).length === 0) return;
    let disposed = false;
    let loading = false;
    const timer = setInterval(() => {
      const pending = Object.entries(polling).filter(([, until]) => until > Date.now());
      if (pending.length === 0) {
        clearInterval(timer);
        return;
      }
      if (loading) return;
      loading = true;
      void api.accounts().then(next => {
        if (disposed) return;
        setAccounts(next);
        const remaining = pending.filter(([name]) => next.accounts.some(a => a.name === name && a.status.state !== "logged_in"));
        if (remaining.length !== Object.keys(polling).length) setPolling(Object.fromEntries(remaining));
        // A fresh sign-in has usage to show now, not at the next five-minute refresh. Done by the
        // load effect because setPolling above disposes this one before a reply could land.
        if (remaining.length < pending.length) setRevision(n => n + 1);
      }, e => { if (!disposed) setProblem(toApiError(e)); }).finally(() => { loading = false; });
    }, 3_000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [api, polling]);

  async function login(name: string) {
    const result = await api.loginAccount(name);
    setCommand(result.opened ? undefined : result.command);
    setCopy(undefined);
    setPolling(previous => ({ ...previous, [name]: Date.now() + 300_000 }));
  }
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setProblem(undefined);
    try {
      await action();
    } catch (e) {
      setProblem(toApiError(e));
    } finally {
      setBusy(false);
    }
  }
  function openForm(importing: boolean) {
    setProblem(undefined);
    setFolder(importing ? "" : null);
    setAdding(true);
  }
  function closeForm() {
    setAdding(false);
    setName("");
    setProvider("claude");
    setFolder(null);
  }
  async function browse() {
    const picked = await api.pickFolder();
    if (!picked) return;
    setFolder(picked);
    // A hive folder is named like the account (`claude-2`, `codex-3`).
    const base = picked.split(/[\\/]/).filter(Boolean).pop() ?? "";
    if (!name) setName(base.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+/, "").slice(0, 32));
    if (base.toLowerCase().startsWith("codex")) setProvider("codex");
  }
  async function add() {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      setProblem({ code: "bad_name" });
      return;
    }
    const dir = folder?.trim();
    if (folder !== null && !dir) {
      setProblem({ code: "not_found" });
      return;
    }
    await run(async () => {
      const account = await api.addAccount(name, provider, dir);
      closeForm();
      setRevision(n => n + 1);
      // An imported folder keeps its own sign-in.
      if (!dir) await login(account.name);
    });
  }
  function resetText(resetsAt: string | null) {
    if (resetsAt === null || !Number.isFinite(Date.parse(resetsAt))) return t("accounts.resetUnknown");
    const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - Date.now()) / 60_000));
    return t("accounts.resets", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  function asOfText(asOf: string) {
    const time = Date.parse(asOf);
    return t("accounts.asOf", { time: Number.isFinite(time) ? new Date(time).toLocaleString() : asOf });
  }
  const all = accounts?.accounts ?? [];
  const reserve = accounts?.reservePercent ?? 0;
  const quotaOf = (account: Account) => quotas.find(q => q.name === account.name);
  const stateOf = (account: Account): State => quotaOf(account)?.state ?? "unknown";
  const fiveHour = (account: Account) => quotaOf(account)?.windows.find(w => w.key === "five_hour");
  const needle = query.trim().toLowerCase();
  const shown = all
    .filter(a => filter === "all" || stateOf(a) === filter)
    .filter(a => needle === "" || [a.name, a.provider, a.status.email, a.status.plan, a.status.org].some(v => v?.toLowerCase().includes(needle)))
    .sort((a, b) => RANK[stateOf(a)] - RANK[stateOf(b)]);
  const counted = (f: Filter) => f === "all" ? all.length : all.filter(a => stateOf(a) === f).length;
  const buckets = Object.fromEntries(BUCKETS.map(b => [b, 0])) as Record<Bucket, number>;
  for (const a of all) buckets[bucketOf(minutesUntil(fiveHour(a)?.resetsAt))] += 1;
  // A blocked account reopens when its 5-hour window resets; the soonest known one is named.
  const blocked = all
    .filter(a => stateOf(a) === "full" || stateOf(a) === "reserve")
    .map(a => ({ account: a, minutes: minutesUntil(fiveHour(a)?.resetsAt) }))
    .filter((b): b is { account: Account; minutes: number } => b.minutes !== null)
    .sort((a, b) => a.minutes - b.minutes)[0];
  const table = layout === null ? all.length >= TABLE_FROM : layout === "table";

  function windowLabel(key: string) {
    return ["five_hour", "seven_day"].includes(key) ? t(`accounts.window.${key}`) : key;
  }
  function percentText(percent: number | null) {
    return percent === null ? t("accounts.unknownPercent") : t("accounts.percent", { percent: Math.round(percent) });
  }
  function bar(label: string, percent: number | null, state: State) {
    return <div className="account-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : clamp(percent)}>
      <div className="account-fill" data-state={state} style={{ width: `${percent === null ? 0 : clamp(percent)}%` }} />
      {reserve > 0 && <span className="account-limit" aria-hidden="true" style={{ left: `${100 - reserve}%` }} />}
    </div>;
  }
  function loginButton(account: Account) {
    const quota = quotaOf(account);
    return (account.status.state !== "logged_in" || quota?.reason === "expired") && <Button type="button" style={COMPACT} disabled={busy} onClick={() => run(() => login(account.name))}>{t("accounts.login")}</Button>;
  }
  function confirmRemove(account: Account) {
    return <div className="account-confirm">
      <p>{t("accounts.keepFolder", { dir: account.dir })}</p>
      <Button type="button" style={COMPACT} disabled={busy} onClick={() => run(async () => { await api.removeAccount(account.name); setRemoving(null); setRevision(n => n + 1); })}>{t("accounts.confirmRemove")}</Button>
      <Button type="button" style={COMPACT} disabled={busy} onClick={() => setRemoving(null)}>{t("accounts.cancel")}</Button>
    </div>;
  }
  function who(account: Account) {
    return [account.status.email, account.status.plan, account.status.org].filter(Boolean).join(" · ");
  }
  function card(account: Account) {
    const quota = quotaOf(account);
    const state = stateOf(account);
    return <section className="account-card" key={account.name} aria-label={account.name} data-state={state}>
      <div className="account-row account-card-head">
        <span className="account-dot" data-state={state} aria-hidden="true" />
        <h2>{account.name}</h2>
        <span className="badge account-provider" data-provider={account.provider}>{t(`accounts.provider.${account.provider}`)}</span>
        <span className="badge" data-state={account.status.state}>{t(`accounts.status.${account.status.state}`)}</span>
        <span className="badge account-state" data-state={state}>{t(`accounts.state.${state}`)}</span>
      </div>
      <p className="doc-path">{who(account)}</p>
      {state === "unknown" && <p className="account-reason">{t(`accounts.reason.${quota?.reason ?? "unavailable"}`)}</p>}
      {quota?.asOf && <p className="doc-path account-as-of">{asOfText(quota.asOf)}</p>}
      {quota?.windows.map(window => {
        const label = windowLabel(window.key);
        return <div className="account-window" key={window.key}>
          <div className="account-row"><span className="account-window-label">{label}</span><span className="account-percent">{percentText(window.utilization)}</span><span className="doc-path">{resetText(window.resetsAt)}</span></div>
          {bar(label, window.utilization, state)}
        </div>;
      })}
      <div className="account-row account-actions">
        {loginButton(account)}
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => setRemoving(account.name)}>{t("accounts.remove")}</Button>
      </div>
      {removing === account.name && confirmRemove(account)}
    </section>;
  }
  function cell(account: Account, key: string) {
    const window = quotaOf(account)?.windows.find(w => w.key === key);
    if (!window) return <div role="cell" className="account-cell-bar"><span className="doc-path">{t("accounts.unknownPercent")}</span></div>;
    const label = `${account.name} · ${windowLabel(key)}`;
    return <div role="cell" className="account-cell-bar">
      <div className="account-row"><span className="account-percent">{percentText(window.utilization)}</span><span className="doc-path">{resetText(window.resetsAt)}</span></div>
      {bar(label, window.utilization, stateOf(account))}
    </div>;
  }
  function row(account: Account) {
    const state = stateOf(account);
    return [
      <div role="row" className="account-tr" key={account.name} data-state={state}>
        <div role="cell" className="account-cell-name">
          <span className="account-dot" data-state={state} aria-hidden="true" />
          <span className="account-name-text"><strong>{account.name}</strong><span className="doc-path">{who(account) || t(`accounts.status.${account.status.state}`)}</span></span>
        </div>
        <div role="cell"><span className="badge account-provider" data-provider={account.provider}>{t(`accounts.provider.${account.provider}`)}</span></div>
        {cell(account, "five_hour")}
        {cell(account, "seven_day")}
        <div role="cell"><span className="badge account-state" data-state={state}>{t(`accounts.state.${state}`)}</span></div>
        <div role="cell" className="account-cell-actions">
          {loginButton(account)}
          <button type="button" className="btn-secondary account-remove" disabled={busy} onClick={() => setRemoving(account.name)}>{t("accounts.remove")}</button>
        </div>
      </div>,
      removing === account.name && <div role="row" className="account-tr account-tr-confirm" key={`${account.name}:confirm`}><div role="cell">{confirmRemove(account)}</div></div>,
    ];
  }
  function resets() {
    return <section className="account-resets" aria-labelledby="account-resets-title">
      <h2 id="account-resets-title" className="account-section-title">{t("accounts.resetTitle")}</h2>
      <ul className="account-buckets">
        {BUCKETS.map(b => <li key={b} className="account-bucket" data-bucket={b} data-some={buckets[b] > 0}>
          <span className="account-bucket-count">{buckets[b]}</span>
          <span className="account-bucket-label">{t(`accounts.bucket.${b}`)}</span>
        </li>)}
      </ul>
      <p className="account-next">{blocked
        ? t("accounts.nextBlocked", { name: blocked.account.name, when: t("accounts.resets", { hours: Math.floor(blocked.minutes / 60), minutes: blocked.minutes % 60 }) })
        : t("accounts.noneBlocked")}</p>
    </section>;
  }
  function toolbar() {
    return <>
      <div className="account-toolbar" role="search">
        <input type="search" className="account-search" value={query} placeholder={t("accounts.search")} aria-label={t("accounts.search")} onChange={e => setQuery(e.target.value)} spellCheck={false} />
        <div className="account-chips" role="group" aria-label={t("accounts.filterLabel")}>
          {FILTERS.map(f => <button type="button" key={f} className="account-chip" data-filter={f} aria-pressed={filter === f} onClick={() => setFilter(f)}>
            <span>{f === "all" ? t("accounts.filter.all") : t(`accounts.state.${f}`)}</span>
            <span className="account-chip-count">{counted(f)}</span>
          </button>)}
        </div>
        <div className="segmented account-layout" role="group" aria-label={t("accounts.view.label")}>
          <button type="button" aria-pressed={table} onClick={() => setLayout("table")}>{t("accounts.view.table")}</button>
          <button type="button" aria-pressed={!table} onClick={() => setLayout("cards")}>{t("accounts.view.cards")}</button>
        </div>
      </div>
      <p className="account-showing doc-path" role="status">{t("accounts.showing", { shown: shown.length, total: all.length })}</p>
    </>;
  }
  function list() {
    if (shown.length === 0) return <div className="account-nomatch">
      <p>{t("accounts.noMatch")}</p>
      <button type="button" className="btn-secondary" onClick={() => { setQuery(""); setFilter("all"); }}>{t("accounts.clearFilters")}</button>
    </div>;
    if (!table) return <div className="account-list">{shown.map(card)}</div>;
    return <div className="account-table" role="table" aria-label={t("accounts.title")}>
      <div role="row" className="account-tr account-th">
        <div role="columnheader">{t("accounts.name")}</div>
        <div role="columnheader">{t("accounts.providerLabel")}</div>
        <div role="columnheader">{t("accounts.window.five_hour")}</div>
        <div role="columnheader">{t("accounts.window.seven_day")}</div>
        <div role="columnheader">{t("accounts.column.state")}</div>
        <div role="columnheader" aria-label={t("accounts.column.actions")} />
      </div>
      {shown.flatMap(row)}
    </div>;
  }
  return <div className="accounts-view">
    <div className="agentctx-head">
      <div className="doc-titles"><h1 className="doc-title">{t("accounts.title")}{accounts && accounts.accounts.length > 0 && <span className="account-count">{accounts.accounts.length}</span>}</h1>{accounts && <span className="doc-subtitle">{t("accounts.reserve", { percent: accounts.reservePercent })}</span>}</div>
      <div className="doc-actions">
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => { setProblem(undefined); setRevision(n => n + 1); }}>{t("accounts.refresh")}</button>
        <button type="button" className="btn-secondary" disabled={busy} onClick={() => openForm(true)}>{t("accounts.import")}</button>
        {accounts?.accounts.length !== 0 && <Button type="button" style={COMPACT} disabled={busy} onClick={() => openForm(false)}>{t("accounts.add")}</Button>}
      </div>
    </div>
    {problem && <ProblemNote problem={problem} />}
    {adding && <form className="account-row account-add" onSubmit={async e => { e.preventDefault(); await add(); }}>
      {folder !== null && <>
        <p className="account-add-hint">{t("accounts.importHint")}</p>
        <label className="account-add-folder">{t("accounts.folder")}<input value={folder} onChange={e => setFolder(e.target.value)} disabled={busy} autoFocus spellCheck={false} />
          <button type="button" className="btn-secondary" disabled={busy} onClick={() => run(browse)}>{t("accounts.browse")}</button></label>
      </>}
      <label>{t("accounts.name")}<input value={name} onChange={e => setName(e.target.value)} disabled={busy} autoFocus={folder === null} /></label>
      <label>{t("accounts.providerLabel")}<select value={provider} onChange={e => setProvider(e.target.value as Provider)} disabled={busy}>
        {PROVIDERS.map(p => <option key={p} value={p}>{t(`accounts.provider.${p}`)}</option>)}
      </select></label>
      <Button type="submit" style={COMPACT} disabled={busy}>{t(folder === null ? "accounts.addLogin" : "accounts.importSubmit")}</Button>
      <Button type="button" style={COMPACT} disabled={busy} onClick={closeForm}>{t("accounts.cancel")}</Button>
    </form>}
    {command && <div className="account-command">
      <p>{t("accounts.runCommand")}</p><pre className="commands">{command}</pre>
      <Button type="button" style={COMPACT} onClick={async () => { try { await navigator.clipboard.writeText(command); setCopy("copied"); } catch { setCopy("copyFailed"); } }}>{t("connect.copy")}</Button>
      {copy && <span role="status">{t(`connect.${copy}`)}</span>}
    </div>}
    {accounts === undefined ? !problem && <p className="placeholder">{t("accounts.loading")}</p> : accounts.accounts.length === 0 ? <div className="placeholder"><p>{t("accounts.empty")}</p><Button type="button" style={COMPACT} onClick={() => openForm(false)}>{t("accounts.add")}</Button></div> : <>{resets()}{toolbar()}{list()}</>}
    <RoutingRules api={api} />
  </div>;
}
