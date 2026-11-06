import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type DeployPreset, type TargetsView } from "@/api";
import { useI18n } from "@/i18n";
import { TrustDialog } from "@/workspace/TrustDialog";
import type { Sessions } from "@/workspace/sessions";
import { DeployConfirm } from "./DeployConfirm";
import { openServerShell, runDeploy } from "./runTarget";
import { runSim } from "./runSim";
import { pushToast } from "@/workspace/toastStore";
import { onTargetsRequest } from "./targetsEvents";
import { needsTrust } from "./targetsModel";

type Trusting = { hash: string; text: string; busy: boolean; error?: ApiError["code"] };

/**
 * What the Run targets menu does, kept in the tab strip's owner so the confirm and the trust dialog
 * outlive the menu (which closes when an item is picked). `dialogs` goes anywhere in the tree.
 */
export function useRunTargets(props: {
  api: Api;
  sessions: Sessions;
  worktree: string;
  repoName: string;
  /** This worktree is the one on screen; only it answers the palette. */
  visible: boolean;
  /** Opens the `+` menu. */
  openMenu(): void;
}): { deploy(preset: DeployPreset): void; server(view: TargetsView): void; review(view: TargetsView): void; dialogs: JSX.Element | null } {
  const { api, sessions, worktree, visible } = props;
  const { t } = useI18n();
  const [confirm, setConfirm] = useState<{ preset: DeployPreset; resolve(ok: boolean): void } | null>(null);
  const [trusting, setTrusting] = useState<Trusting | null>(null);
  const [openMenu] = useState(() => ({ current: props.openMenu }));
  openMenu.current = props.openMenu;

  const deploy = useCallback(
    (preset: DeployPreset) => {
      void runDeploy(preset, {
        sessions,
        worktree,
        t,
        confirm: (p) => new Promise<boolean>((resolve) => setConfirm({ preset: p, resolve })),
      });
    },
    [sessions, worktree, t],
  );

  const review = useCallback((view: TargetsView) => {
    setTrusting({ hash: view.hash, text: view.text ?? "", busy: false });
  }, []);

  const server = useCallback(
    (view: TargetsView) => {
      if (!view.vps) return;
      if (needsTrust(view)) return review(view);
      void openServerShell(view.vps, { api, sessions, worktree });
    },
    [api, sessions, worktree, review],
  );

  useEffect(() => {
    if (!visible) return;
    return onTargetsRequest((req) => {
      if (req.kind === "menu") return openMenu.current();
      if (req.kind === "sim") {
        void runSim(req.device, { api, sessions, worktree, t }).then((res) => {
          if (!res.ok) pushToast({ text: t(`error.${res.code}`) });
        });
        return;
      }
      void api.targetsList(worktree).then((view) => server(view), () => {});
    });
  }, [visible, api, sessions, worktree, server, t]);

  async function trust(): Promise<void> {
    if (!trusting) return;
    setTrusting({ ...trusting, busy: true });
    try {
      await api.targetsTrust(worktree, trusting.hash);
      setTrusting(null);
    } catch (e) {
      setTrusting({ ...trusting, busy: false, error: toApiError(e).code });
    }
  }

  const answer = (ok: boolean) => {
    confirm?.resolve(ok);
    setConfirm(null);
  };

  const dialogs = (
    <>
      {confirm && <DeployConfirm preset={confirm.preset} onConfirm={() => answer(true)} onCancel={() => answer(false)} />}
      {trusting && (
        <TrustDialog
          repo={props.repoName}
          file="xdev.toml"
          kind="commands"
          text={trusting.text}
          changed={false}
          busy={trusting.busy}
          error={trusting.error}
          onTrust={() => void trust()}
          onCancel={() => setTrusting(null)}
        />
      )}
    </>
  );
  return { deploy, server, review, dialogs: confirm || trusting ? dialogs : null };
}
