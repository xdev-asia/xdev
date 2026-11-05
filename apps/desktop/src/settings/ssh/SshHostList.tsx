import { Button, Checkbox, EmptyState, Spinner, StatusDot, Tag } from "@xdev-asia/ui";
import type { JSX } from "react";
import type { SshConnState, SshHost, SshTestOutcome } from "@/api";
import { useI18n } from "@/i18n";
import { connLine, endpoint, isLive, testLine, type Line } from "./sshModel";

/** A host's test: running, or its outcome. */
export type TestState = "running" | SshTestOutcome;

/** The rows of the saved hosts: a tick, the alias, where it goes and where it came from. */
export function SshHostList(props: {
  hosts: readonly SshHost[];
  /** How many hosts there are before the filter, to tell "none yet" from "none match". */
  total: number;
  selected: ReadonlySet<string>;
  /** The last test per host id, shown under the host until the next one. */
  tests?: ReadonlyMap<string, TestState>;
  /** The kept connection per host id; a host with none is disconnected. */
  conns?: ReadonlyMap<string, SshConnState>;
  onToggle(id: string): void;
  onEdit(host: SshHost): void;
  onRemove(host: SshHost): void;
  onTest?(host: SshHost): void;
  onConnect?(host: SshHost): void;
  onDisconnect?(host: SshHost): void;
}): JSX.Element {
  const { t } = useI18n();
  if (props.hosts.length === 0) {
    return props.total === 0 ? (
      <EmptyState title={t("ssh.empty")} hint={t("ssh.emptyHint")} />
    ) : (
      <EmptyState title={t("ssh.noMatch")} />
    );
  }
  const status = (line: Line, testId: string): JSX.Element => (
    <span className="ssh-row-status" data-testid={testId} data-tone={line.tone}>
      <StatusDot tone={line.tone} label={t(line.key, line.vars)} />
    </span>
  );
  return (
    <ul className="settings-list">
      {props.hosts.map((h) => {
        const test = props.tests?.get(h.id);
        const conn = props.conns?.get(h.id);
        const live = isLive(conn);
        return (
          <li key={h.id} className="settings-item ssh-row" data-testid="ssh-row">
            <Checkbox
              aria-label={t("ssh.select", { alias: h.alias })}
              checked={props.selected.has(h.id)}
              onChange={() => props.onToggle(h.id)}
            />
            <div className="settings-item-text">
              <strong>{h.alias}</strong>
              <span className="ws-mono settings-path">{endpoint(h)}</span>
              {conn && conn.kind !== "disconnected" && status(connLine(conn), "ssh-conn-state")}
              {test === "running" && (
                <span className="ssh-row-status" data-testid="ssh-test-result">
                  <Spinner label={t("ssh.test.running", { alias: h.alias })} />
                  {t("ssh.test.runningShort")}
                </span>
              )}
              {test && test !== "running" && status(testLine(test), "ssh-test-result")}
            </div>
            <Tag>{t(h.source === "sshConfig" ? "ssh.source.config" : "ssh.source.manual")}</Tag>
            <div className="ssh-row-actions">
              {props.onTest && (
                <Button type="button" variant="secondary" disabled={test === "running"} onClick={() => props.onTest?.(h)}>
                  {t("ssh.test")}
                </Button>
              )}
              {live
                ? props.onDisconnect && (
                    <Button type="button" variant="secondary" onClick={() => props.onDisconnect?.(h)}>
                      {t("ssh.disconnect")}
                    </Button>
                  )
                : props.onConnect && (
                    <Button type="button" variant="secondary" onClick={() => props.onConnect?.(h)}>
                      {t("ssh.connect")}
                    </Button>
                  )}
              <Button type="button" variant="secondary" onClick={() => props.onEdit(h)}>
                {t("ssh.edit")}
              </Button>
              <Button type="button" variant="secondary" onClick={() => props.onRemove(h)}>
                {t("ssh.remove")}
              </Button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
