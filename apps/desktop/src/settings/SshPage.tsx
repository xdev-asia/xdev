import { Button, Checkbox, SearchInput } from "@xdev-asia/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { JSX } from "react";
import { toApiError, type ApiError, type SshConnState, type SshHost, type SshSyncReport } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { SettingRow } from "./SettingRow";
import type { SettingsSectionProps } from "./sections";
import { SshHostDialog } from "./ssh/SshHostDialog";
import { SshHostList, type TestState } from "./ssh/SshHostList";
import { filterHosts, syncLine } from "./ssh/sshModel";

/** Settings › SSH: the saved hosts, added by hand or read from `~/.ssh/config`. */
export function SshPage(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [hosts, setHosts] = useState<SshHost[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [editing, setEditing] = useState<{ item: SshHost | null } | null>(null);
  const [removing, setRemoving] = useState<SshHost[] | null>(null);
  const [report, setReport] = useState<SshSyncReport>();
  const [error, setError] = useState<ApiError["code"]>();
  const [tests, setTests] = useState<ReadonlyMap<string, TestState>>(new Map());
  const [conns, setConns] = useState<ReadonlyMap<string, SshConnState>>(new Map());
  const setConn = useCallback((id: string, state: SshConnState) => setConns((m) => new Map(m).set(id, state)), []);

  const reload = useCallback(async () => {
    const next = await api.sshHostsList();
    setHosts(next);
    // A removed host cannot stay ticked.
    setSelected((s) => new Set([...s].filter((id) => next.some((h) => h.id === id))));
  }, [api]);

  async function act(run: () => Promise<unknown>): Promise<void> {
    setError(undefined);
    try {
      await run();
      await reload();
      props.onChanged();
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  useEffect(() => {
    reload().catch((e: unknown) => setError(toApiError(e).code));
  }, [reload]);

  // Kept connections: the current list, then every change as it happens.
  useEffect(() => {
    let live = true;
    const off = api.onSshState((v) => setConn(v.hostId, v.state));
    api
      .sshConnectionsList()
      .then((list) => {
        if (live) setConns(new Map(list.map((v) => [v.hostId, v.state])));
      })
      .catch(() => {});
    return () => {
      live = false;
      void off.then((f) => f());
    };
  }, [api, setConn]);

  const setTest = (id: string, state: TestState): void => setTests((m) => new Map(m).set(id, state));
  async function test(host: SshHost): Promise<void> {
    setTest(host.id, "running");
    try {
      setTest(host.id, await api.sshHostTest(host.id));
    } catch (e) {
      setTests((m) => {
        const next = new Map(m);
        next.delete(host.id);
        return next;
      });
      setError(toApiError(e).code);
    }
  }
  async function connection(run: () => Promise<unknown>): Promise<void> {
    setError(undefined);
    try {
      await run();
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  const shown = useMemo(() => filterHosts(hosts, query), [hosts, query]);
  const toggle = (id: string): void =>
    setSelected((s) => {
      const next = new Set(s);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const allShown = shown.length > 0 && shown.every((h) => selected.has(h.id));
  const sync = (): void => void act(async () => setReport(await api.sshConfigSync()));
  const confirmRemove = (): void => {
    const gone = removing;
    setRemoving(null);
    if (gone) void act(() => api.sshHostsRemoveMany(gone.map((h) => h.id)));
  };
  const line = report ? syncLine(report) : null;

  return (
    <div className="settings-page ssh-page">
      <header className="settings-head">
        <h3>{t("ssh.title")}</h3>
        <p>{t("ssh.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      <SettingRow id="ssh.hosts" filter={props.filter}>
        <div className="ssh-tools">
          <SearchInput
            size="sm"
            value={query}
            placeholder={t("ssh.search")}
            labels={{ search: t("ssh.search"), clear: t("ssh.searchClear") }}
            onChange={(e) => setQuery(e.target.value)}
            onClear={() => setQuery("")}
          />
          <Button type="button" variant="secondary" onClick={sync}>
            {t("ssh.sync")}
          </Button>
          <Button type="button" onClick={() => setEditing({ item: null })}>
            {t("ssh.add")}
          </Button>
        </div>
        {line && (
          <p className="settings-hint" role="status" data-testid="ssh-sync-line">
            {t(line.key, line.vars)}
            {report?.includeIgnored ? ` ${t("ssh.sync.include")}` : ""}
          </p>
        )}
        {shown.length > 0 && (
          <div className="ssh-bulk">
            <Checkbox
              label={selected.size > 0 ? t("ssh.selected", { n: selected.size }) : t("ssh.selectAll")}
              checked={allShown}
              indeterminate={selected.size > 0 && !allShown}
              onChange={() => setSelected(allShown ? new Set() : new Set(shown.map((h) => h.id)))}
            />
            {selected.size > 0 && (
              <Button type="button" variant="secondary" onClick={() => setRemoving(hosts.filter((h) => selected.has(h.id)))}>
                {t("ssh.removeSelected")}
              </Button>
            )}
          </div>
        )}
        <SshHostList
          hosts={shown}
          total={hosts.length}
          selected={selected}
          tests={tests}
          conns={conns}
          onToggle={toggle}
          onEdit={(h) => setEditing({ item: h })}
          onRemove={(h) => setRemoving([h])}
          onTest={(h) => void test(h)}
          onConnect={(h) => void connection(async () => setConn(h.id, (await api.sshConnect(h.id)).state))}
          onDisconnect={(h) => void connection(() => api.sshDisconnect(h.id))}
        />
      </SettingRow>

      {editing && (
        <SshHostDialog
          api={api}
          initial={editing.item}
          others={hosts.filter((h) => h.id !== editing.item?.id).map((h) => h.alias)}
          onSaved={() => {
            setEditing(null);
            void act(async () => {});
          }}
          onCancel={() => setEditing(null)}
        />
      )}
      <ConfirmDialog
        open={removing !== null}
        title={t("ssh.removeTitle")}
        body={t("ssh.removeBody")}
        confirmLabel={t("ssh.remove")}
        onConfirm={confirmRemove}
        onCancel={() => setRemoving(null)}
      />
    </div>
  );
}
