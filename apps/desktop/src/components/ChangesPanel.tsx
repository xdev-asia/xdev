import { Button } from "@xdev/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Change } from "../api";
import type { Changes, Problem } from "../changes/useChanges";
import { useI18n } from "../i18n";
import { DiffView } from "./DiffView";

// Shell commands, so they stay in English whatever the UI language.
const IDENTITY_COMMANDS = 'git config --global user.name "Your Name"\ngit config --global user.email you@example.com';

export const COMPACT = { padding: "var(--x-space-1) var(--x-space-3)" };

export function ProblemNote(props: { problem: Problem }): JSX.Element {
  const { t } = useI18n();
  const { code, detail } = props.problem;
  return (
    <div className="banner banner-warn" role="alert">
      <div className="banner-text">
        <span>{t(code === "unsaved" ? "changes.unsaved" : `error.${code}`)}</span>
        {code === "git_identity" && <pre className="commands">{IDENTITY_COMMANDS}</pre>}
        {/* For `git` the detail is git's own output (e.g. a failing hook), the only clue to what went wrong. */}
        {code === "git" && detail && <pre className="commands">{detail}</pre>}
      </div>
    </div>
  );
}

export function ChangeBadges(props: { change: Change }): JSX.Element {
  const { t } = useI18n();
  return (
    <span className="badges">
      <span className="badge" data-kind={props.change.kind}>
        {t(`changes.kind.${props.change.kind}`)}
      </span>
      <span className="badge">{t(`changes.origin.${props.change.origin}`)}</span>
    </span>
  );
}

export function ChangesPanel(props: {
  review: Changes;
  selected: string | null;
  message: string;
  onMessage(message: string): void;
  onSelect(path: string): void;
  onApprove(paths: string[]): void;
  onReject(changes: Change[]): void;
}): JSX.Element {
  const { t } = useI18n();
  const { status, changes, busy, error } = props.review;
  return (
    <section className="pane" aria-label={t("changes.title")}>
      <div className="pane-head">
        <span>{t("changes.title")}</span>
        {status === "ok" && <span className="pane-count">{t("changes.count", { count: changes.length })}</span>}
      </div>
      {error && <ProblemNote problem={error} />}
      {status === "loading" && <p className="pane-empty">{t("changes.loading")}</p>}
      {status === "no_git" && (
        <div className="pane-empty pane-note">
          <p>{t("changes.noGit")}</p>
          <p>{t("changes.noGitHint")}</p>
        </div>
      )}
      {status === "no_repo" && (
        <div className="pane-empty pane-note">
          <p>{t("changes.noRepo")}</p>
          <Button type="button" style={COMPACT} disabled={busy} onClick={() => void props.review.init()}>
            {busy ? t("changes.starting") : t("changes.start")}
          </Button>
        </div>
      )}
      {status === "ok" && changes.length === 0 && <p className="pane-empty">{t("changes.empty")}</p>}
      {status === "ok" && changes.length > 0 && (
        <>
          <div className="approve-all">
            <input
              className="field"
              value={props.message}
              placeholder={t("changes.message")}
              aria-label={t("changes.message")}
              onChange={(e) => props.onMessage(e.target.value)}
            />
            <Button
              type="button"
              style={COMPACT}
              disabled={busy}
              onClick={() => props.onApprove(changes.map((c) => c.path))}
            >
              {t("changes.approveAll")}
            </Button>
          </div>
          <ul className="changelist">
            {changes.map((change) => (
              <li key={change.path} className="change" aria-current={change.path === props.selected ? "true" : undefined}>
                <button type="button" className="change-open" title={change.path} onClick={() => props.onSelect(change.path)}>
                  <span className="change-path">{change.path}</span>
                  <ChangeBadges change={change} />
                </button>
                <div className="change-actions">
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => props.onApprove([change.path])}>
                    {t("changes.approve")}
                  </button>
                  <button type="button" className="btn-secondary" disabled={busy} onClick={() => props.onReject([change])}>
                    {t("changes.reject")}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

type Loaded = { base: string; current: string };

// The editor-area view of one pending change. Keyed by path, so switching files starts from "loading".
export function ChangeView(props: {
  api: Api;
  change: Change;
  revision: number;
  busy: boolean;
  onApprove(): void;
  onReject(): void;
  onOpenDoc(): void;
  onClose(): void;
}): JSX.Element {
  const { t } = useI18n();
  const { api, change } = props;
  const [loaded, setLoaded] = useState<Loaded>();
  const [problem, setProblem] = useState<Problem>();

  useEffect(() => {
    let stale = false;
    // Reloads on every refresh (the revision), so the diff follows edits that keep arriving.
    Promise.all([api.readBase(change.path), change.kind === "deleted" ? "" : api.readDoc(change.path)]).then(
      ([base, current]) => {
        if (stale) return;
        setLoaded({ base: base ?? "", current });
        setProblem(undefined);
      },
      (e: unknown) => !stale && setProblem(toApiError(e)),
    );
    return () => {
      stale = true;
    };
  }, [api, change.path, change.kind, props.revision]);

  const name = change.path.split("/").pop() ?? change.path;
  return (
    <div className="docview">
      <div className="doc-head">
        <div className="doc-titles">
          <h1 className="doc-title">{name}</h1>
          <span className="doc-path">{change.path}</span>
        </div>
        <div className="doc-actions">
          <ChangeBadges change={change} />
          {change.kind !== "deleted" && (
            <button type="button" className="btn-secondary" onClick={props.onOpenDoc}>
              {t("diff.open")}
            </button>
          )}
          <button type="button" className="btn-secondary" disabled={props.busy} onClick={props.onReject}>
            {t("changes.reject")}
          </button>
          <Button type="button" style={COMPACT} disabled={props.busy} onClick={props.onApprove}>
            {t("changes.approve")}
          </Button>
          <button type="button" className="btn-secondary" onClick={props.onClose}>
            {t("diff.close")}
          </button>
        </div>
      </div>
      {problem && <ProblemNote problem={problem} />}
      {loaded === undefined ? (
        !problem && <p className="placeholder">{t("diff.loading")}</p>
      ) : (
        <>
          {loaded.base === loaded.current && <p className="diff-note">{t("diff.same")}</p>}
          <DiffView base={loaded.base} current={loaded.current} />
        </>
      )}
    </div>
  );
}
