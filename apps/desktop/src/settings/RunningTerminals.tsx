import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PtydStatus, type SessionInfo } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { useI18n } from "@/i18n";

type Ask = { kind: "end"; session: SessionInfo } | { kind: "endAll" } | { kind: "restart" };

/** Settings → Terminal → Running terminals: what the terminal service holds, with End and Restart. */
export function RunningTerminals(props: { api: Api }): JSX.Element {
  const { api } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState<PtydStatus | null>(null);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [asking, setAsking] = useState<Ask | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError["code"]>();

  async function load(): Promise<void> {
    try {
      const [s, list] = await Promise.all([api.ptydStatus(), api.ptydSessions()]);
      setStatus(s);
      setSessions(list);
    } catch (e) {
      setError(toApiError(e).code);
    }
  }

  useEffect(() => {
    void load();
    const off = api.onPtydStatus(() => void load());
    return () => void off.then((stop) => stop());
  }, [api]);

  const up = status?.state === "running" || status?.state === "old-version";
  const count = sessions.length;
  const name = (s: SessionInfo) => s.meta.profile ?? s.program;

  async function confirm(): Promise<void> {
    const ask = asking;
    setAsking(null);
    if (!ask) return;
    setBusy(true);
    setError(undefined);
    try {
      if (ask.kind === "end") await api.ptydEnd(ask.session.id);
      else if (ask.kind === "endAll") await api.ptydEndAll();
      else await api.ptydRestart();
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(false);
      await load();
    }
  }

  const question =
    asking?.kind === "end"
      ? { title: t("settings.terminal.service.endTitle"), body: t("settings.terminal.service.endBody", { name: name(asking.session) }), label: t("settings.terminal.service.end") }
      : asking?.kind === "endAll"
        ? { title: t("settings.terminal.service.endAllTitle", { count }), body: t("settings.terminal.service.endAllBody", { count }), label: t("settings.terminal.service.endAll") }
        : { title: t("settings.terminal.service.restartTitle"), body: t("settings.terminal.service.restartBody", { count }), label: t("settings.terminal.service.restart") };

  return (
    <>
      <h4 className="settings-group">{t("settings.terminal.service.running")}</h4>
      {error && (
        <p className="error-text" role="alert">
          {t(`error.${error}`)}
        </p>
      )}
      {status && !up && <p className="settings-empty">{t("settings.terminal.service.off")}</p>}
      {up && (
        <>
          {count === 0 && <p className="settings-empty">{t("settings.terminal.service.none")}</p>}
          <ul className="settings-list">
            {sessions.map((s) => (
              <li key={s.id} className="settings-item" data-session={s.id}>
                <div className="settings-item-text">
                  <strong>{name(s)}</strong>
                  <span className="settings-path">{s.meta.worktree ?? s.cwd}</span>
                  <span className="settings-hint">{t(s.attached ? "settings.terminal.service.attached" : "settings.terminal.service.detached")}</span>
                </div>
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => setAsking({ kind: "end", session: s })}>
                  {t("settings.terminal.service.end")}
                </button>
              </li>
            ))}
          </ul>
          <div className="settings-actions settings-actions-start">
            <button type="button" className="btn-secondary" disabled={busy || count === 0} onClick={() => setAsking({ kind: "endAll" })}>
              {t("settings.terminal.service.endAll")}
            </button>
            <button type="button" className="btn-secondary" disabled={busy} onClick={() => setAsking({ kind: "restart" })}>
              {t("settings.terminal.service.restart")}
            </button>
          </div>
        </>
      )}
      <ConfirmDialog
        open={asking !== null}
        title={question.title}
        body={question.body}
        confirmLabel={question.label}
        onConfirm={() => void confirm()}
        onCancel={() => setAsking(null)}
      />
    </>
  );
}
