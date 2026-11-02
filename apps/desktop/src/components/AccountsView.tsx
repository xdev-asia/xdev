import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import { toApiError, type Account, type Accounts, type Api, type ApiError, type Quota } from "../api";
import { useI18n } from "../i18n";
import { COMPACT, ProblemNote } from "./ChangesPanel";

export function AccountsView({ api }: { api: Api }) {
  const { t } = useI18n();
  const [accounts, setAccounts] = useState<Accounts>();
  const [quotas, setQuotas] = useState<Quota[]>([]);
  const [problem, setProblem] = useState<ApiError>();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<string | null>(null);
  const [command, setCommand] = useState<string>();
  const [copy, setCopy] = useState<"copied" | "copyFailed">();
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [polling, setPolling] = useState<Record<string, number>>({});

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
  async function add() {
    if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(name)) {
      setProblem({ code: "bad_name" });
      return;
    }
    await run(async () => {
      const account = await api.addAccount(name);
      setAdding(false);
      setName("");
      setRevision(n => n + 1);
      await login(account.name);
    });
  }
  function resetText(resetsAt: string | null) {
    if (resetsAt === null || !Number.isFinite(Date.parse(resetsAt))) return t("accounts.resetUnknown");
    const minutes = Math.max(0, Math.ceil((Date.parse(resetsAt) - Date.now()) / 60_000));
    return t("accounts.resets", { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
  }
  function card(account: Account) {
    const quota = quotas.find(q => q.name === account.name);
    const state = quota?.state ?? "unknown";
    return <section className="account-card" key={account.name} aria-label={account.name}>
      <div className="account-row">
        <h2>{account.name}</h2>
        <span className="badge" data-state={account.status.state}>{t(`accounts.status.${account.status.state}`)}</span>
        <span className="badge account-state" data-state={state}>{t(`accounts.state.${state}`)}</span>
      </div>
      <p className="doc-path">{[account.status.email, account.status.plan, account.status.org].filter(Boolean).join(" · ")}</p>
      {state === "unknown" && <p>{t(`accounts.reason.${quota?.reason ?? "unavailable"}`)}</p>}
      {quota?.windows.map(window => {
        const label = ["five_hour", "seven_day"].includes(window.key) ? t(`accounts.window.${window.key}`) : window.key;
        const percent = window.utilization;
        return <div className="account-window" key={window.key}>
          <div className="account-row"><span>{label}</span><span>{percent === null ? t("accounts.unknownPercent") : t("accounts.percent", { percent: Math.round(percent) })}</span><span className="doc-path">{resetText(window.resetsAt)}</span></div>
          <div className="account-bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent === null ? undefined : Math.min(100, Math.max(0, percent))}>
            <div className="account-fill" data-state={state} style={{ width: `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%` }} />
          </div>
        </div>;
      })}
      <div className="account-row">
        {(account.status.state !== "logged_in" || quota?.reason === "expired") && <Button type="button" style={COMPACT} disabled={busy} onClick={() => run(() => login(account.name))}>{t("accounts.login")}</Button>}
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => setRemoving(account.name)}>{t("accounts.remove")}</Button>
      </div>
      {removing === account.name && <div className="account-confirm">
        <p>{t("accounts.keepFolder", { dir: account.dir })}</p>
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => run(async () => { await api.removeAccount(account.name); setRemoving(null); setRevision(n => n + 1); })}>{t("accounts.confirmRemove")}</Button>
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => setRemoving(null)}>{t("accounts.cancel")}</Button>
      </div>}
    </section>;
  }
  return <div className="accounts-view">
    <div className="agentctx-head">
      <div className="doc-titles"><h1 className="doc-title">{t("accounts.title")}</h1>{accounts && <span className="doc-path">{t("accounts.reserve", { percent: accounts.reservePercent })}</span>}</div>
      <div className="doc-actions">
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => { setProblem(undefined); setRevision(n => n + 1); }}>{t("accounts.refresh")}</Button>
        <Button type="button" style={COMPACT} disabled={busy} onClick={() => setAdding(true)}>{t("accounts.add")}</Button>
      </div>
    </div>
    {problem && <ProblemNote problem={problem} />}
    {adding && <form className="account-row account-add" onSubmit={async e => { e.preventDefault(); await add(); }}>
      <label>{t("accounts.name")}<input value={name} onChange={e => setName(e.target.value)} disabled={busy} autoFocus /></label>
      <Button type="submit" style={COMPACT} disabled={busy}>{t("accounts.addLogin")}</Button>
      <Button type="button" style={COMPACT} disabled={busy} onClick={() => setAdding(false)}>{t("accounts.cancel")}</Button>
    </form>}
    {command && <div className="account-command">
      <p>{t("accounts.runCommand")}</p><pre className="commands">{command}</pre>
      <Button type="button" style={COMPACT} onClick={async () => { try { await navigator.clipboard.writeText(command); setCopy("copied"); } catch { setCopy("copyFailed"); } }}>{t("connect.copy")}</Button>
      {copy && <span role="status">{t(`connect.${copy}`)}</span>}
    </div>}
    {accounts === undefined ? !problem && <p className="placeholder">{t("accounts.loading")}</p> : accounts.accounts.length === 0 ? <div className="placeholder"><p>{t("accounts.empty")}</p><Button type="button" style={COMPACT} onClick={() => setAdding(true)}>{t("accounts.add")}</Button></div> : <div className="account-list">{accounts.accounts.map(card)}</div>}
  </div>;
}
