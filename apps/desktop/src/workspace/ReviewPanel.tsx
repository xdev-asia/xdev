import { useEffect, useState } from "react";
import type { ComponentProps, JSX } from "react";
import type { ReviewHost } from "@/api";
import { useI18n } from "@/i18n";
import { MrPanel } from "./MrPanel";
import { PrPanel } from "./PrPanel";

/**
 * The review panel of a worktree: the merge request on a GitLab remote, the pull request anywhere
 * else. A read that fails falls back to the pull request panel, which shows its own error.
 */
export function ReviewPanel(props: ComponentProps<typeof PrPanel>): JSX.Element {
  const { api, worktree } = props;
  const { t } = useI18n();
  // The host a worktree was read for; another worktree reads again.
  const [host, setHost] = useState<{ worktree: string; host: ReviewHost } | null>(null);

  useEffect(() => {
    let live = true;
    api.worktreeShip(worktree).then(
      (ship) => live && setHost({ worktree, host: ship.reviewHost }),
      () => live && setHost({ worktree, host: "github" }),
    );
    return () => {
      live = false;
    };
  }, [api, worktree]);

  if (!host || host.worktree !== worktree) {
    return (
      <div className="pr-panel">
        <p className="ws-empty" role="status">{t("prPanel.loading")}</p>
      </div>
    );
  }
  if (host.host === "gitlab") {
    return (
      <MrPanel
        api={api}
        worktree={worktree}
        visible={props.visible}
        page={props.page}
        onOpenPage={props.onOpenPage}
        onOpenGitSettings={props.onOpenGitSettings}
      />
    );
  }
  return <PrPanel {...props} />;
}
