import { Button, Checkbox, EmptyState, Tag } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { SshHost } from "@/api";
import { useI18n } from "@/i18n";
import { endpoint } from "./sshModel";

/** The rows of the saved hosts: a tick, the alias, where it goes and where it came from. */
export function SshHostList(props: {
  hosts: readonly SshHost[];
  /** How many hosts there are before the filter, to tell "none yet" from "none match". */
  total: number;
  selected: ReadonlySet<string>;
  onToggle(id: string): void;
  onEdit(host: SshHost): void;
  onRemove(host: SshHost): void;
}): JSX.Element {
  const { t } = useI18n();
  if (props.hosts.length === 0) {
    return props.total === 0 ? (
      <EmptyState title={t("ssh.empty")} hint={t("ssh.emptyHint")} />
    ) : (
      <EmptyState title={t("ssh.noMatch")} />
    );
  }
  return (
    <ul className="settings-list">
      {props.hosts.map((h) => (
        <li key={h.id} className="settings-item ssh-row" data-testid="ssh-row">
          <Checkbox
            aria-label={t("ssh.select", { alias: h.alias })}
            checked={props.selected.has(h.id)}
            onChange={() => props.onToggle(h.id)}
          />
          <div className="settings-item-text">
            <strong>{h.alias}</strong>
            <span className="ws-mono settings-path">{endpoint(h)}</span>
          </div>
          <Tag>{t(h.source === "sshConfig" ? "ssh.source.config" : "ssh.source.manual")}</Tag>
          <div className="ssh-row-actions">
            <Button type="button" variant="secondary" onClick={() => props.onEdit(h)}>
              {t("ssh.edit")}
            </Button>
            <Button type="button" variant="secondary" onClick={() => props.onRemove(h)}>
              {t("ssh.remove")}
            </Button>
          </div>
        </li>
      ))}
    </ul>
  );
}
