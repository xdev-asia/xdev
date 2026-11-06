import { Checkbox, Field, IconButton, Select, Switch } from "@xdev-asia/ui";
import { useEffect, useRef, useState } from "react";
import type { JSX } from "react";
import { hasQuota, toApiError, type AccountRouting, type Api, type Provider, type RoutePolicy } from "@/api";
import { useI18n } from "@/i18n";
import { SettingGroup, SettingRow } from "../SettingRow";
import type { SettingsFilter } from "../sections";

export const ROUTE_POLICIES: readonly RoutePolicy[] = ["manual", "most_quota", "round_robin", "priority"];
const ROW_IDS = ["account.routing.policy", "account.routing.pool", "account.routing.priority", "account.routing.thresholds", "account.routing.autoSwitch"];

/** A percent the user typed: a whole number from 1 to 100, else null. */
export function parsePercent(text: string): number | null {
  if (!/^\s*\d{1,3}\s*$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 100 ? n : null;
}

/** The priority order as shown: the saved order first, then the other routable accounts. */
export function priorityOrder(routing: AccountRouting, names: readonly string[]): string[] {
  const routable = routing.pool.length === 0 ? names : names.filter((n) => routing.pool.includes(n));
  return [...routing.priority.filter((n) => routable.includes(n)), ...routable.filter((n) => !routing.priority.includes(n))];
}

type Drafts = { first: string; second: string; switchAt: string };
const draftsOf = (r: AccountRouting): Drafts => ({ first: String(r.thresholds[0] ?? ""), second: String(r.thresholds[1] ?? ""), switchAt: String(r.switchAt) });

/**
 * Settings → Account: per provider, which account a new agent tab starts on, when quota alerts
 * fire, and whether new agents move off an account near its limit. Running tabs never change.
 */
export function RoutingSection(props: { api: Pick<Api, "accounts" | "accountsRouting" | "accountRoutingSet" | "onAccountsChanged">; filter?: SettingsFilter }): JSX.Element | null {
  const { api, filter } = props;
  const { t } = useI18n();
  const [routing, setRouting] = useState<AccountRouting[] | null>(null);
  const [names, setNames] = useState<Partial<Record<Provider, string[]>>>({});
  const [drafts, setDrafts] = useState<Partial<Record<Provider, Drafts>>>({});
  const [note, setNote] = useState<{ provider: Provider; text: string; error: boolean } | null>(null);
  const buttons = useRef(new Map<string, HTMLButtonElement | null>());
  const [focus, setFocus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    let stop: (() => void) | undefined;
    const load = () =>
      void Promise.all([api.accountsRouting(), api.accounts()]).then(
        ([r, a]) => {
          if (!live) return;
          setRouting(r);
          setDrafts(Object.fromEntries(r.map((x) => [x.provider, draftsOf(x)])));
          setNames(Object.fromEntries(r.map((x) => [x.provider, a.accounts.filter((y) => y.provider === x.provider).map((y) => y.name)])));
        },
        () => undefined,
      );
    load();
    void api.onAccountsChanged(load).then((off) => {
      if (live) stop = off;
      else off();
    });
    return () => {
      live = false;
      stop?.();
    };
  }, [api]);

  useEffect(() => {
    if (focus === null) return;
    buttons.current.get(focus)?.focus();
    setFocus(null);
  }, [focus, routing]);

  if (!routing) return null;

  function save(next: AccountRouting, done = t("settings.account.routing.saved")): void {
    setRouting((all) => all && all.map((r) => (r.provider === next.provider ? next : r)));
    api.accountRoutingSet(next).then(
      () => setNote({ provider: next.provider, text: done, error: false }),
      (e: unknown) => {
        setNote({ provider: next.provider, text: t(`error.${toApiError(e).code}`), error: true });
        void api.accountsRouting().then(setRouting, () => undefined);
      },
    );
  }

  function section(r: AccountRouting): JSX.Element {
    const p = r.provider;
    const provider = t(`accounts.provider.${p}`);
    const own = names[p] ?? [];
    // "Most quota left" needs a quota source; a provider without one never offers it.
    const policies = ROUTE_POLICIES.filter((v) => v !== "most_quota" || hasQuota(p) || r.policy === v);
    const draft = drafts[p] ?? draftsOf(r);
    const edit = (patch: Partial<Drafts>) => setDrafts((d) => ({ ...d, [p]: { ...draft, ...patch } }));
    const first = parsePercent(draft.first);
    const second = draft.second.trim() === "" ? null : parsePercent(draft.second);
    const switchAt = parsePercent(draft.switchAt);
    const checked = (name: string) => r.pool.length === 0 || r.pool.includes(name);
    const order = priorityOrder(r, own);

    function togglePool(name: string, on: boolean): void {
      const next = own.filter((n) => (n === name ? on : checked(n)));
      // Every account checked is stored as "every account", so one added later joins the pool.
      save({ ...r, pool: next.length === own.length ? [] : next });
    }

    function move(at: number, by: -1 | 1): void {
      const next = [...order];
      const [name] = next.splice(at, 1);
      next.splice(at + by, 0, name);
      const to = at + by;
      const dir = (to === 0 && by === -1) || (to === next.length - 1 && by === 1) ? (by === -1 ? "down" : "up") : by === -1 ? "up" : "down";
      setFocus(`${p}:${name}:${dir}`);
      save({ ...r, priority: next }, t("settings.account.routing.moved", { name, position: to + 1 }));
    }

    function saveThresholds(): void {
      if (first === null || (draft.second.trim() !== "" && second === null)) return;
      const next = [...new Set(second === null ? [first] : [first, second])].sort((a, b) => a - b);
      if (next.join() !== r.thresholds.join()) save({ ...r, thresholds: next });
    }

    function saveSwitchAt(): void {
      if (switchAt !== null && switchAt !== r.switchAt) save({ ...r, switchAt });
    }

    const percentError = (text: string, value: number | null) => (text.trim() !== "" && value === null ? t("settings.account.routing.percentError") : undefined);

    return (
      <section key={p} aria-labelledby={`routing-${p}`} data-provider={p}>
        <h5 className="settings-subgroup" id={`routing-${p}`}>
          {provider}
        </h5>
        <SettingRow id="account.routing.policy" filter={filter}>
          <div className="ws-fields">
            <label className="ws-field">
              <span>{t("settings.account.routing.policy")}</span>
              <Select
                value={r.policy}
                data-field="policy"
                onChange={(e) => save({ ...r, policy: e.target.value as RoutePolicy })}
                options={policies.map((v) => ({ value: v, label: t(`settings.account.routing.policy.${v}`) }))}
              />
            </label>
          </div>
          <p className="settings-empty">{t(`settings.account.routing.policy.${r.policy}Hint`)}</p>
          {!hasQuota(p) && <p className="settings-empty" data-field="no-quota">{t("settings.account.routing.noQuotaSource", { provider })}</p>}
        </SettingRow>
        <SettingRow id="account.routing.pool" filter={filter}>
          {own.length === 0 ? (
            <p className="settings-empty">{t("settings.account.routing.noAccounts", { provider })}</p>
          ) : (
            <fieldset className="settings-git-checks" data-field="pool">
              <legend>{t("settings.account.routing.pool")}</legend>
              {own.map((name) => {
                const on = checked(name);
                const last = on && own.filter(checked).length === 1;
                return <Checkbox key={name} label={name} checked={on} disabled={last} hint={last ? t("settings.account.routing.poolLast") : undefined} onChange={(e) => togglePool(name, e.target.checked)} />;
              })}
            </fieldset>
          )}
        </SettingRow>
        {r.policy === "priority" && order.length > 0 && (
          <SettingRow id="account.routing.priority" filter={filter}>
            <p className="settings-empty" id={`routing-${p}-priority`}>
              {t("settings.account.routing.priority")}
            </p>
            <ol className="settings-list" aria-labelledby={`routing-${p}-priority`} data-field="priority">
              {order.map((name, i) => (
                <li key={name} className="settings-item">
                  <div className="settings-item-text">
                    <strong>{name}</strong>
                  </div>
                  <div className="settings-actions">
                    <IconButton
                      icon="arrow-up"
                      label={t("settings.account.routing.moveUp", { name })}
                      disabled={i === 0}
                      ref={(el) => void buttons.current.set(`${p}:${name}:up`, el)}
                      onClick={() => move(i, -1)}
                    />
                    <IconButton
                      icon="arrow-down"
                      label={t("settings.account.routing.moveDown", { name })}
                      disabled={i === order.length - 1}
                      ref={(el) => void buttons.current.set(`${p}:${name}:down`, el)}
                      onClick={() => move(i, 1)}
                    />
                  </div>
                </li>
              ))}
            </ol>
          </SettingRow>
        )}
        <SettingRow id="account.routing.thresholds" filter={filter}>
          <div className="ws-fields" data-field="thresholds">
            <Field
              label={t("settings.account.routing.firstAlert")}
              inputMode="numeric"
              value={draft.first}
              error={percentError(draft.first, first) ?? (draft.first.trim() === "" ? t("settings.account.routing.percentError") : undefined)}
              onChange={(e) => edit({ first: e.target.value })}
              onBlur={saveThresholds}
              onKeyDown={(e) => e.key === "Enter" && saveThresholds()}
            />
            <Field
              label={t("settings.account.routing.secondAlert")}
              hint={t("settings.account.routing.secondAlertHint")}
              inputMode="numeric"
              value={draft.second}
              error={percentError(draft.second, second)}
              onChange={(e) => edit({ second: e.target.value })}
              onBlur={saveThresholds}
              onKeyDown={(e) => e.key === "Enter" && saveThresholds()}
            />
          </div>
          <p className="settings-empty">{t("settings.account.routing.thresholdsHint")}</p>
        </SettingRow>
        <SettingRow id="account.routing.autoSwitch" filter={filter}>
          <Switch
            data-field="autoSwitch"
            checked={r.autoSwitch}
            label={t("settings.account.routing.autoSwitch", { percent: r.switchAt })}
            onChange={(e) => save({ ...r, autoSwitch: e.target.checked })}
          />
          <div className="ws-fields">
            <Field
              label={t("settings.account.routing.switchAt")}
              inputMode="numeric"
              value={draft.switchAt}
              error={percentError(draft.switchAt, switchAt) ?? (draft.switchAt.trim() === "" ? t("settings.account.routing.percentError") : undefined)}
              onChange={(e) => edit({ switchAt: e.target.value })}
              onBlur={saveSwitchAt}
              onKeyDown={(e) => e.key === "Enter" && saveSwitchAt()}
            />
          </div>
          <p className="settings-empty">{t("settings.account.routing.terms")}</p>
        </SettingRow>
        <p className="settings-hint" role="status" data-field="routing-status" data-error={note?.provider === p && note.error ? "" : undefined}>
          {note?.provider === p ? note.text : ""}
        </p>
      </section>
    );
  }

  return (
    <SettingGroup ids={ROW_IDS} filter={filter}>
      <h4 className="settings-group">{t("settings.account.routing.title")}</h4>
      <p className="settings-empty">{t("settings.account.routing.lead")}</p>
      {routing.map(section)}
    </SettingGroup>
  );
}
