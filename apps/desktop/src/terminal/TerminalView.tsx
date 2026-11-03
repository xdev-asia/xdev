import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type PtyProfile } from "@/api";
import { COMPACT } from "@/components/ChangesPanel";
import { useI18n } from "@/i18n";
import { Terminal } from "./Terminal";
import { useApprovedStart } from "./useApprovedStart";

// The picker offers the plain shell and the built-in agents; the workspace `+` menu has the rest.
const PTY_PROFILES: readonly PtyProfile[] = ["shell", "claude", "codex"];

type Run = { id: string; cwd: string; profile: PtyProfile; approved: boolean };

let serial = 0;
const nextId = () => `term-${Date.now()}-${++serial}`;

/** The Terminal app: pick a folder and a profile, then a shell or an agent runs in it. */
export function TerminalView({ api }: { api: Api }): JSX.Element {
  const { t } = useI18n();
  const [cwd, setCwd] = useState<string | null>(null);
  const [profile, setProfile] = useState<PtyProfile>("shell");
  const [run, setRun] = useState<Run | null>(null);
  const [exit, setExit] = useState<{ id: string; code: number | null } | null>(null);
  const { ask, error, setError, dialog } = useApprovedStart(api);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let gone = false;
    void api.onPtyExit((e) => setExit(e)).then((off) => (gone ? off() : (unlisten = off)));
    return () => {
      gone = true;
      unlisten?.();
    };
  }, [api]);

  const start = (next: Run) => {
    setError(null);
    setExit(null);
    setRun(next);
  };

  const failed = (failedRun: Run, e: ApiError) => {
    setRun(null);
    ask(failedRun.profile, e, failedRun.approved, () => start({ ...failedRun, id: nextId(), approved: true }));
  };

  const exited = run && exit?.id === run.id ? exit : null;

  return (
    <div className="terminal-view">
      <div className="terminal-toolbar">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => void api.pickFolder().then((dir) => dir && setCwd(dir), (e) => setError(toApiError(e)))}
        >
          {t("terminal.pickFolder")}
        </button>
        <span className="terminal-folder" title={cwd ?? undefined}>
          {cwd ?? t("terminal.noFolder")}
        </span>
        <label className="terminal-profile">
          <span>{t("terminal.profile")}</span>
          <select value={profile} onChange={(e) => setProfile(e.target.value as PtyProfile)}>
            {PTY_PROFILES.map((p) => (
              <option key={p} value={p}>
                {t(`terminal.profile.${p}`)}
              </option>
            ))}
          </select>
        </label>
        {run ? (
          <button type="button" className="btn-secondary" onClick={() => setRun(null)}>
            {t("terminal.stop")}
          </button>
        ) : (
          <Button
            style={COMPACT}
            disabled={!cwd}
            onClick={() => cwd && start({ id: nextId(), cwd, profile, approved: false })}
          >
            {t("terminal.start")}
          </Button>
        )}
        {exited && (
          <span className="terminal-exit" role="status">
            {exited.code === null ? t("terminal.exitedUnknown") : t("terminal.exited", { code: exited.code })}
          </span>
        )}
      </div>
      {error && (
        <div className="banner banner-warn" role="alert">
          <div className="banner-text">
            <span>{t(`error.${error.code}`)}</span>
            {error.detail && <pre className="commands">{error.detail}</pre>}
          </div>
        </div>
      )}
      {run ? (
        <Terminal
          key={run.id}
          api={api}
          id={run.id}
          cwd={run.cwd}
          profile={run.profile}
          onStarted={() => {}}
          onError={(e) => failed(run, e)}
        />
      ) : (
        <p className="pane-empty terminal-empty">{t("terminal.empty")}</p>
      )}
      {dialog}
    </div>
  );
}
