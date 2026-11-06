import { Banner, Button } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { needsBanner, stateText } from "./model";
import type { RemoteProjectView } from "@/api";

/** Above the editor and terminals of a remote worktree that is reconnecting or offline. */
export function RemoteBanner(props: { project: RemoteProjectView | undefined; onReconnect(project: RemoteProjectView): void }): JSX.Element | null {
  const { t } = useI18n();
  const p = props.project;
  if (!p || !needsBanner(p.state)) return null;
  const offline = p.state.state === "offline";
  return (
    <div className="remote-banner">
      <Banner
        title={stateText(t, p.state, p.hostAlias)}
        action={
          offline ? (
            <Button type="button" variant="secondary" onClick={() => props.onReconnect(p)}>
              {t("remote.action.reconnect")}
            </Button>
          ) : undefined
        }
      >
        {offline ? t("remote.banner.offline.hint") : null}
      </Banner>
    </div>
  );
}
