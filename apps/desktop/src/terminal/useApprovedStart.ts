import { createElement, useState } from "react";
import type { JSX } from "react";
import { profileName, useProfiles } from "@/agents/profileStore";
import { toApiError, type Api, type ApiError, type PtyInfo, type PtyProfile } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";
import type { PtyClient } from "./ptyClient";

type Asking = { profile: PtyProfile; account: string | null; reason: string; retry: () => void; cancel: () => void };

/**
 * The approval flow of an agent start: a refused start asks once, approves in the policy,
 * then starts again. Reads the profile names from `useProfiles`, so a harness that stubs hooks must stub `useContext` too.
 */
export function useApprovedStart(api: Api): {
  /** Starts a client's pty; `null` when it failed (see `error`) or approval was declined. */
  start(
    client: PtyClient,
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: (bytes: Uint8Array, rendered: () => void) => void,
    account?: string | null,
  ): Promise<PtyInfo | null>;
  /**
   * For a view that restarts on its own: reports a failed start. A first `needs_approval`
   * opens the dialog and, once approved, calls `retry`; anything else becomes `error`.
   * `cancel` runs when the start is given up: declined, refused again, or failed otherwise.
   */
  ask(profile: PtyProfile, error: ApiError, alreadyApproved: boolean, retry: () => void, cancel?: () => void, account?: string | null): void;
  error: ApiError | null;
  setError(error: ApiError | null): void;
  dialog: JSX.Element;
} {
  const { t } = useI18n();
  const { view } = useProfiles();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const ask = (
    profile: PtyProfile,
    e: ApiError,
    alreadyApproved: boolean,
    retry: () => void,
    cancel: () => void = () => {},
    account: string | null = null,
  ) => {
    // Approval is asked once per start; a second refusal is shown as is.
    if (e.code === "needs_approval" && !alreadyApproved) {
      setAsking({ profile, account, reason: e.detail ?? "", retry, cancel });
      return;
    }
    setError(e);
    cancel();
  };

  const approve = async () => {
    if (!asking) return;
    const { profile, account, retry, cancel } = asking;
    setAsking(null);
    try {
      await api.ptyApprove(profile, account);
      retry();
    } catch (e) {
      setError(toApiError(e));
      cancel();
    }
  };

  const decline = () => {
    asking?.cancel();
    setAsking(null);
  };

  const start = async (
    client: PtyClient,
    cwd: string,
    profileId: PtyProfile,
    cols: number,
    rows: number,
    write: (bytes: Uint8Array, rendered: () => void) => void,
    account: string | null = null,
  ): Promise<PtyInfo | null> => {
    setError(null);
    const attempt = async (approved: boolean): Promise<PtyInfo | null> => {
      try {
        return await client.start(cwd, profileId, cols, rows, write, account);
      } catch (e) {
        return new Promise<PtyInfo | null>((resolve) =>
          ask(
            profileId,
            toApiError(e),
            approved,
            () => void attempt(true).then(resolve),
            () => resolve(null),
            account,
          ),
        );
      }
    };
    return attempt(false);
  };

  const dialog = createElement(ConfirmDialog, {
    open: asking !== null,
    title: t("terminal.approve.title"),
    body: asking ? t("terminal.approve.body", { profile: profileName(view, asking.profile, t), reason: asking.reason }) : "",
    confirmLabel: t("terminal.approve.confirm"),
    onConfirm: () => void approve(),
    onCancel: decline,
  });

  return { start, ask, error, setError, dialog };
}
