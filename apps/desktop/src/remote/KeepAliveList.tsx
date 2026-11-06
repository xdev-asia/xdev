import { Switch } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api, RemoteProjectView, SshHost } from "@/api";
import { useI18n } from "@/i18n";

/**
 * Settings › SSH: per host, whether its remote projects keep sessions alive with tmux. Read only:
 * the choice is made when a project is added and no command changes it yet.
 */
export function KeepAliveList(props: { api: Partial<Pick<Api, "remoteProjectsList">>; hosts: SshHost[] }): JSX.Element | null {
  const { t } = useI18n();
  const [projects, setProjects] = useState<RemoteProjectView[]>([]);
  const list = props.api.remoteProjectsList;
  useEffect(() => {
    let live = true;
    void Promise.resolve()
      .then(() => list?.())
      .then(
        (p) => live && setProjects(p ?? []),
        () => undefined,
      );
    return () => {
      live = false;
    };
  }, [list, props.hosts]);
  if (!list || props.hosts.length === 0) return null;
  return (
    <section className="remote-keepalive" aria-label={t("remote.keepAlive")}>
      <p className="settings-hint">{t("remote.keepAlive.hint")}</p>
      {props.hosts.map((h) => {
        const mine = projects.filter((p) => p.hostId === h.id);
        return (
          <div key={h.id} className="settings-row">
            <Switch
              label={`${t("remote.keepAlive")} · ${h.alias}`}
              checked={mine.length > 0 && mine.every((p) => p.keepAlive)}
              disabled
              readOnly
            />
            {mine.length === 0 && <span className="settings-hint">{t("remote.keepAlive.none")}</span>}
          </div>
        );
      })}
    </section>
  );
}
