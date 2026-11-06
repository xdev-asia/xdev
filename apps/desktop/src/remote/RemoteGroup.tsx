import { Button, ListRow, StatusDot, Tag } from "@xdev-asia/ui";
import { useState } from "react";
import type { JSX } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import { ContextMenu, type MenuItem } from "@/ui/ContextMenu";
import { stateText, type RemoteRow } from "./model";

/**
 * The sidebar's Remote group: a row per remote project (name, host alias, connection dot). The
 * context menu, or the "More" button, has Reconnect, Disconnect and Remove from xDev; removing asks
 * first and never touches the folder on the host.
 */
export function RemoteGroup(props: {
  rows: RemoteRow[];
  selected: string | null;
  onSelect(row: RemoteRow): void;
  onReconnect(row: RemoteRow): void;
  onDisconnect(row: RemoteRow): void;
  onRemove(row: RemoteRow): void;
}): JSX.Element | null {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ row: RemoteRow; at: { x: number; y: number } } | null>(null);
  const [removing, setRemoving] = useState<RemoteRow | null>(null);
  if (props.rows.length === 0) return null;

  const items = (row: RemoteRow): MenuItem[] => [
    { id: "reconnect", labelKey: "remote.action.reconnect", run: () => props.onReconnect(row) },
    { id: "disconnect", labelKey: "remote.action.disconnect", disabled: row.state.state === "idle", run: () => props.onDisconnect(row) },
    { id: "sep", labelKey: "", kind: "separator" },
    { id: "remove", labelKey: "remote.action.remove", danger: true, run: () => setRemoving(row) },
  ];

  return (
    <section aria-labelledby="remote-group-title">
      <h3 id="remote-group-title" className="remote-group-title">
        {t("remote.sidebar.group")}
      </h3>
      <ul className="remote-group">
        {props.rows.map((row) => (
          <li key={row.id} data-remote={row.id}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ row, at: { x: e.clientX, y: e.clientY } });
              }}
          >
          <ListRow
              className="remote-row"
              selected={props.selected === row.worktree}
              onClick={() => props.onSelect(row)}
              title={
                <>
                  <StatusDot tone={row.dot.tone} label={stateText(t, row.state, row.host)} />
                  <span className="remote-row-name">{row.name}</span>
                  <Tag>{row.host}</Tag>
                </>
              }
              trailing={
                <Button
                  type="button"
                  variant="secondary"
                  className="remote-row-more"
                  aria-label={t("remote.sidebar.row", { name: row.name, host: row.host })}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ row, at: { x: r.left, y: r.bottom } });
                  }}
                >
                  …
                </Button>
              }
            />
          </li>
        ))}
      </ul>
      {menu && <ContextMenu at={menu.at} items={items(menu.row)} title={menu.row.name} onClose={() => setMenu(null)} />}
      <ConfirmDialog
        open={removing !== null}
        title={t("remote.remove.title")}
        body={removing ? t("remote.remove.confirm", { name: removing.name, host: removing.host }) : ""}
        confirmLabel={t("remote.remove.submit")}
        titleId="remote-remove-title"
        onConfirm={() => {
          if (removing) props.onRemove(removing);
          setRemoving(null);
        }}
        onCancel={() => setRemoving(null)}
      />
    </section>
  );
}
