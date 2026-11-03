import { createElement, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PtyInfo, type PtyProfile } from "../api";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useI18n } from "../i18n";
import type { PtyClient } from "./ptyClient";

type Asking = { profile: PtyProfile; reason: string; retry: () => void; cancel: () => void };

/**
 * The approval flow of an agent start: a refused start asks once, approves in the policy,
 * then starts again. Uses only `useState` and `useI18n`.
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
  ): Promise<PtyInfo | null>;
  /**
   * For a view that restarts on its own: reports a failed start. A first `needs_approval`
   * opens the dialog and, once approved, calls `retry`; anything else becomes `error`.
   * `cancel` runs when the start is given up: declined, refused again, or failed otherwise.
   */
  ask(profile: PtyProfile, error: ApiError, alreadyApproved: boolean, retry: () => void, cancel?: () => void): void;
  error: ApiError | null;
  setError(error: ApiError | null): void;
  dialog: JSX.Element;
} {
  const { t } = useI18n();
  const [asking, setAsking] = useState<Asking | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  const ask = (
    profile: PtyProfile,
    e: ApiError,
    alreadyApproved: boolean,
    retry: () => void,
    cancel: () => void = () => {},
  ) => {
    // Approval is asked once per start; a second refusal is shown as is.
    if (e.code === "needs_approval" && !alreadyApproved) {
      setAsking({ profile, reason: e.detail ?? "", retry, cancel });
      return;
    }
    setError(e);
    cancel();
  };

  const approve = async () => {
    if (!asking) return;
    const { profile, retry, cancel } = asking;
    setAsking(null);
    try {
      await api.ptyApprove(profile);
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
  ): Promise<PtyInfo | null> => {
    setError(null);
    const attempt = async (approved: boolean): Promise<PtyInfo | null> => {
      try {
        return await client.start(cwd, profileId, cols, rows, write);
      } catch (e) {
        return new Promise<PtyInfo | null>((resolve) =>
          ask(
            profileId,
            toApiError(e),
            approved,
            () => void attempt(true).then(resolve),
            () => resolve(null),
          ),
        );
      }
    };
    return attempt(false);
  };

  const dialog = createElement(ConfirmDialog, {
    open: asking !== null,
    title: t("terminal.approve.title"),
    body: asking ? t("terminal.approve.body", { profile: t(`terminal.profile.${asking.profile}`), reason: asking.reason }) : "",
    confirmLabel: t("terminal.approve.confirm"),
    onConfirm: () => void approve(),
    onCancel: decline,
  });

  return { start, ask, error, setError, dialog };
}
