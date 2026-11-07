import { Button, Icon as UiIcon, type IconName } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Change } from "@/api";
import type { Changes, Problem } from "@/changes/useChanges";
import { useI18n } from "@/i18n";
import { DiffStats, DiffView } from "./DiffView";

// Shell commands, so they stay in English whatever the UI language.
const IDENTITY_COMMANDS = 'git config --global user.name "Your Name"\ngit config --global user.email you@example.com';

export const COMPACT = { padding: "var(--x-space-1) var(--x-space-3)" };

// Icon names (xdev-ui) shared by the Changes, History and Agents views.
export const ICON = {
  check: "check",
  close: "close",
  doc: "file",
  restore: "restore",
  history: "history",
  bot: "bot",
  download: "download",
  copy: "copy",
  plug: "plug",
  warn: "warn-dash",
  lock: "lock",
} as const satisfies Record<string, IconName>;

/** An xdev-ui icon; `d` takes a value of `ICON`. */
export function Icon(props: { d: IconName; size?: number }): JSX.Element {
  return <UiIcon name={props.d} size={props.size} />;
}

// What a draft says when the recipe's agent is the problem: a profile with no runner or gone, or
// the policy stopping its run. The recipe is in Settings → Git.
const RECIPE_CODES: ReadonlySet<string> = new Set(["unsupported_agent", "unknown_profile", "needs_approval", "denied"]);

/** Whether the error comes from the agent a recipe names, so Settings → Git is where to look. */
export function isRecipeProblem(code: string): boolean {
  return RECIPE_CODES.has(code);
}

export function ProblemNote(props: { problem: Problem; onOpenSettings?(): void }): JSX.Element {
  const { t } = useI18n();
  const { code, detail } = props.problem;
  return (
    <div className="banner banner-warn" role="alert">
      <div className="banner-text">
        <span>{t(code === "unsaved" ? "changes.unsaved" : `error.${code}`)}</span>
        {code === "git_identity" && <pre className="commands">{IDENTITY_COMMANDS}</pre>}
        {/* For `git` the detail is git's own output (e.g. a failing hook), the only clue to what went wrong. */}
        {code === "git" && detail && <pre className="commands">{detail}</pre>}
        {/* A denial carries the policy's own reason. */}
        {code === "denied" && detail && <span>{detail}</span>}
        {props.onOpenSettings && isRecipeProblem(code) && (
          <button type="button" className="ws-ship-link" data-open-settings="git" onClick={props.onOpenSettings}>
            {t("recipes.openSettings")}
          </button>
        )}
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
      <span className="badge" data-origin={props.change.origin}>
        {t(`changes.origin.${props.change.origin}`)}
      </span>
    </span>
  );
}

// The agent's own summary of an `ai` change, so the reviewer knows what it meant to do.
export function ChangeNote(props: { change: Change; className: string; icon?: boolean }): JSX.Element | null {
  const { t } = useI18n();
  const { note } = props.change;
  if (!note) return null;
  return (
    <span className={`change-note ${props.className}`}>
      {props.icon && <Icon d={ICON.bot} size={18} />}
      {t("changes.note", { note })}
    </span>
  );
}

export function ChangesPanel(props: {
  review: Changes;
  selected: string | null;
  message: string;
  onMessage(message: string): void;
  onSelect(path: string): void;
  onApprove(changes: Change[]): void;
  onReject(changes: Change[]): void;
}): JSX.Element {
  const { t } = useI18n();
  const { status, changes, busy, error } = props.review;
  return (
    <section className="pane changes-pane" aria-label={t("changes.title")}>
      <div className="changes-head">
        <h2 className="changes-title">{t("changes.title")}</h2>
        {status === "ok" && (
          <span className="changes-count" data-pending={changes.length > 0 || undefined}>
            {t("changes.count", { count: changes.length })}
          </span>
        )}
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
          <Button variant="primary" type="button" style={COMPACT} disabled={busy} onClick={() => void props.review.init()}>
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
            <Button variant="primary"
              type="button"
              className="changes-approve-all"
              style={COMPACT}
              disabled={busy}
              onClick={() => props.onApprove(changes)}
            >
              <Icon d={ICON.check} />
              {t("changes.approveAll")}
            </Button>
            <button
              type="button"
              className="btn-secondary changes-reject-all"
              disabled={busy}
              onClick={() => props.onReject(changes)}
            >
              <Icon d={ICON.close} />
              {t("changes.rejectAll")}
            </button>
          </div>
          <ul className="changelist">
            {changes.map((change) => (
              <li key={change.path} className="change" aria-current={change.path === props.selected ? "true" : undefined}>
                <button type="button" className="change-open" title={change.path} onClick={() => props.onSelect(change.path)}>
                  <span className="change-path">{change.path}</span>
                  <ChangeBadges change={change} />
                  <ChangeNote change={change} className="change-note-list" />
                </button>
                <div className="change-actions">
                  <button
                    type="button"
                    className="change-act"
                    data-act="approve"
                    title={t("changes.approve")}
                    aria-label={t("changes.approveOne", { path: change.path })}
                    disabled={busy}
                    onClick={() => props.onApprove([change])}
                  >
                    <Icon d={ICON.check} />
                  </button>
                  <button
                    type="button"
                    className="change-act"
                    data-act="reject"
                    title={t("changes.reject")}
                    aria-label={t("changes.rejectOne", { path: change.path })}
                    disabled={busy}
                    onClick={() => props.onReject([change])}
                  >
                    <Icon d={ICON.close} />
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

  return (
    <div className="docview changeview">
      <div className="change-head">
        <div className="change-titles">
          <h1 className="change-title">{change.path}</h1>
          <ChangeBadges change={change} />
        </div>
        <div className="change-head-actions">
          {change.kind !== "deleted" && (
            <button type="button" className="btn-secondary" onClick={props.onOpenDoc}>
              <Icon d={ICON.doc} />
              {t("diff.open")}
            </button>
          )}
          <button type="button" className="btn-secondary changes-reject-all" disabled={props.busy} onClick={props.onReject}>
            <Icon d={ICON.close} />
            {t("changes.reject")}
          </button>
          <Button variant="primary" type="button" className="changes-approve-all" style={COMPACT} disabled={props.busy} onClick={props.onApprove}>
            <Icon d={ICON.check} />
            {t("changes.approve")}
          </Button>
          <button type="button" className="btn-secondary" onClick={props.onClose}>
            {t("diff.close")}
          </button>
        </div>
      </div>
      <div className="change-body">
        <ChangeNote change={change} className="diff-note" icon />
        {problem && <ProblemNote problem={problem} />}
        {loaded === undefined ? (
          !problem && <p className="placeholder">{t("diff.loading")}</p>
        ) : (
          <>
            {loaded.base === loaded.current && <p className="diff-note">{t("diff.same")}</p>}
            <DiffCard path={change.path} base={loaded.base} current={loaded.current} />
          </>
        )}
      </div>
    </div>
  );
}

// A diff framed as a card, with the path and the line counts above it.
export function DiffCard(props: { path: string; base: string; current: string }): JSX.Element {
  return (
    <div className="diff-card">
      <div className="diff-card-head">
        <span className="diff-card-path">{props.path}</span>
        <DiffStats base={props.base} current={props.current} />
      </div>
      <DiffView base={props.base} current={props.current} />
    </div>
  );
}
