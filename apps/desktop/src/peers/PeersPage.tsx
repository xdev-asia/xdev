import { Button, Dialog, EmptyState, Field, Select, StatusDot, Switch, Tag } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import type { PeerRole, PeerView } from "@/api";
import { MenuButton } from "@/automations/MenuButton";
import { useI18n } from "@/i18n";
import { SettingRow } from "@/settings/SettingRow";
import type { SettingsSectionProps } from "@/settings/sections";
import { PairDialog } from "./PairDialog";
import { adminNameMatches, errorText, needsAdminConfirm, relativeTime, rolesFor, roleDetailKey, sortPeers } from "./peersModel";
import { usePeers } from "./usePeers";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** One paired computer: status, name, kind, last seen, a role picker and a menu. Pure; the page owns the state. */
export function PeerRow(props: {
  peer: PeerView;
  t: T;
  locale: string;
  now: number;
  onRole(role: PeerRole): void;
  onRename(): void;
  onUnpair(): void;
}): JSX.Element {
  const { peer: p, t } = props;
  const detail = roleDetailKey(p.role);
  return (
    <li className="settings-item peers-row" data-testid="peer-row" data-online={p.online}>
      <div className="settings-item-text">
        <span className="peers-line">
          <StatusDot tone={p.online ? "ok" : "neutral"} label={t(p.online ? "peers.list.online" : "peers.list.offline")} />
          <strong>{p.name}</strong>
          {p.kind === "phone" && <Tag>{t("peers.list.phone")}</Tag>}
          {p.sameXdevId && <Tag>{t("peers.list.sameId")}</Tag>}
        </span>
        {p.lastSeenMs !== null && !p.online && (
          <span className="settings-hint">{t("peers.list.lastSeen", { time: relativeTime(p.lastSeenMs, props.now, props.locale) })}</span>
        )}
        {detail && <span className="settings-hint">{t(detail)}</span>}
      </div>
      <div className="peers-row-actions">
        <Select
          aria-label={t("peers.role.label", { name: p.name })}
          value={p.role}
          options={rolesFor(p.kind).map((r) => ({ value: r, label: t(`peers.role.${r}`) }))}
          onChange={(e) => props.onRole(e.target.value as PeerRole)}
        />
        <MenuButton
          label={t("peers.list.menu", { name: p.name })}
          className="btn-secondary"
          items={[
            { label: t("peers.rename"), onSelect: props.onRename },
            { label: t("peers.remove"), danger: true, onSelect: props.onUnpair },
          ]}
        >
          …
        </MenuButton>
      </div>
    </li>
  );
}

/** Settings › Paired computers. */
export function PeersPage(props: SettingsSectionProps): JSX.Element {
  const { api } = props;
  const { t, locale } = useI18n();
  const { state, peers, reload } = usePeers(api);
  const [error, setError] = useState<string>();
  const [pairing, setPairing] = useState(false);
  const [admin, setAdmin] = useState<{ peer: PeerView; typed: string } | null>(null);
  const [renaming, setRenaming] = useState<{ peer: PeerView; name: string } | null>(null);
  const [unpairing, setUnpairing] = useState<PeerView | null>(null);

  async function act(run: () => Promise<unknown>, name = ""): Promise<void> {
    setError(undefined);
    try {
      await run();
      await reload();
    } catch (e) {
      setError(errorText(t, e, name));
    }
  }

  const setRole = (p: PeerView, role: PeerRole): void => {
    if (needsAdminConfirm(role)) setAdmin({ peer: p, typed: "" });
    else void act(() => api.peerSetRole(p.id, role), p.name);
  };
  const enabled = state?.enabled ?? false;

  return (
    <div className="settings-page peers-page">
      <header className="settings-head">
        <h3>{t("peers.title")}</h3>
        <p>{t("peers.intro")}</p>
      </header>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <SettingRow id="peers.computers" filter={props.filter}>
        <div className="peers-stack">
          <Switch
            label={t("peers.enable")}
            checked={enabled}
            disabled={!state}
            onChange={(e) => void act(() => api.peersSetEnabled(e.target.checked))}
          />
          {enabled && state && (
            <>
              <p className="settings-hint">{t("peers.firewall")}</p>
              <p className="settings-hint peers-fingerprint">{t("peers.fingerprint", { fp: state.fingerprint })}</p>
              <div>
                <Button variant="primary" type="button" onClick={() => setPairing(true)}>
                  {t("peers.pair")}
                </Button>
              </div>
            </>
          )}
          {peers.length === 0 ? (
            <EmptyState title={t("peers.list.empty")} />
          ) : (
            <ul className="settings-list">
              {sortPeers(peers).map((p) => (
                <PeerRow
                  key={p.id}
                  peer={p}
                  t={t}
                  locale={locale}
                  now={Date.now()}
                  onRole={(r) => setRole(p, r)}
                  onRename={() => setRenaming({ peer: p, name: p.name })}
                  onUnpair={() => setUnpairing(p)}
                />
              ))}
            </ul>
          )}
        </div>
      </SettingRow>

      {pairing && <PairDialog api={api} onClose={() => setPairing(false)} onPaired={() => void reload()} />}
      {admin && (
        <Dialog
          modal
          alert
          title={t("peers.role.adminConfirm", { name: admin.peer.name })}
          confirmLabel={t("peers.role.adminGive")}
          cancelLabel={t("peers.cancel")}
          confirmDisabled={!adminNameMatches(admin.typed, admin.peer.name)}
          onCancel={() => setAdmin(null)}
          onConfirm={() => {
            const target = admin.peer;
            setAdmin(null);
            void act(() => api.peerSetRole(target.id, "admin"), target.name);
          }}
        >
          <Field
            label={t("peers.role.adminType", { name: admin.peer.name })}
            value={admin.typed}
            autoComplete="off"
            onChange={(e) => setAdmin({ ...admin, typed: e.target.value })}
          />
        </Dialog>
      )}
      {renaming && (
        <Dialog
          modal
          title={t("peers.rename")}
          confirmLabel={t("peers.rename.save")}
          cancelLabel={t("peers.cancel")}
          confirmDisabled={renaming.name.trim() === ""}
          onCancel={() => setRenaming(null)}
          onConfirm={() => {
            const r = renaming;
            setRenaming(null);
            void act(() => api.peerRename(r.peer.id, r.name.trim()), r.peer.name);
          }}
        >
          <Field label={t("peers.rename.label")} value={renaming.name} onChange={(e) => setRenaming({ ...renaming, name: e.target.value })} />
        </Dialog>
      )}
      {unpairing && (
        <Dialog
          modal
          alert
          title={t("peers.remove")}
          confirmLabel={t("peers.remove")}
          cancelLabel={t("peers.cancel")}
          onCancel={() => setUnpairing(null)}
          onConfirm={() => {
            const target = unpairing;
            setUnpairing(null);
            void act(() => api.peerRemove(target.id), target.name);
          }}
        >
          {t("peers.remove.confirm", { name: unpairing.name })}
        </Dialog>
      )}
    </div>
  );
}
