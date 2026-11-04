import { Button } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type Commit } from "@/api";
import { relativeTime } from "@/changes/changes";
import type { Problem } from "@/changes/useChanges";
import { useI18n } from "@/i18n";
import { COMPACT, DiffCard, ICON, Icon, ProblemNote } from "./ChangesPanel";
import { ConfirmDialog } from "./ConfirmDialog";

const HISTORY_LIMIT = 50;
const SHORT_ID = 7;

// `null` content: the doc did not exist in that commit (e.g. the commit deleted it).
type Version = { id: string; content: string | null };

// History of one doc, shown in place of the editor. Keyed by path, so another doc starts from "loading".
export function HistoryPanel(props: {
  api: Api;
  path: string;
  current: string;
  // Bumped by every Changes refresh, so a fresh approval shows up without reopening the panel.
  revision: number;
  // Resolves to the reason it failed, or null once the version is back on disk.
  onRestore(id: string): Promise<Problem | null>;
}): JSX.Element {
  const { t } = useI18n();
  const { api, path } = props;
  const [commits, setCommits] = useState<Commit[]>();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [selected, setSelected] = useState<Commit | null>(null);
  const [version, setVersion] = useState<Version>();
  const [problem, setProblem] = useState<Problem>();
  const [confirming, setConfirming] = useState(false);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    let stale = false;
    api.history(path, HISTORY_LIMIT).then(
      (found) => {
        if (stale) return;
        setCommits(found);
        setNow(Math.floor(Date.now() / 1000));
        setProblem(undefined);
      },
      (e: unknown) => !stale && setProblem(toApiError(e)),
    );
    return () => {
      stale = true;
    };
  }, [api, path, props.revision]);

  useEffect(() => {
    if (selected === null) return;
    let stale = false;
    setVersion(undefined);
    api.readVersion(path, selected.id).then(
      (content) => !stale && setVersion({ id: selected.id, content }),
      (e: unknown) => !stale && setProblem(toApiError(e)),
    );
    return () => {
      stale = true;
    };
  }, [api, path, selected]);

  async function restore() {
    if (selected === null) return;
    setConfirming(false);
    setRestoring(true);
    setProblem(undefined);
    const failed = await props.onRestore(selected.id);
    // On success the panel is closed by the parent, so only a failure needs local state.
    if (failed) {
      setProblem(failed);
      setRestoring(false);
    }
  }

  const loaded = version !== undefined && version.id === selected?.id ? version : undefined;
  return (
    <div className="history">
      <section className="history-side" aria-label={t("history.title")}>
        <h2 className="history-title">
          <Icon d={ICON.history} />
          {t("history.title")}
        </h2>
        {commits === undefined ? (
          !problem && <p className="pane-empty">{t("history.loading")}</p>
        ) : commits.length === 0 ? (
          <p className="pane-empty">{t("history.empty")}</p>
        ) : (
          <ul className="history-list">
            {commits.map((commit) => {
              const ago = relativeTime(now, commit.time);
              return (
                <li key={commit.id}>
                  <button
                    type="button"
                    className="history-item"
                    aria-current={commit.id === selected?.id ? "true" : undefined}
                    onClick={() => setSelected(commit)}
                  >
                    <span className="history-message">{commit.message}</span>
                    <span className="history-meta">
                      <code className="history-id">{commit.id.slice(0, SHORT_ID)}</code>
                      <span>{commit.author}</span>
                      <span>{t(ago.key, ago.vars)}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <div className="history-main">
        {problem && <ProblemNote problem={problem} />}
        {selected === null ? (
          commits !== undefined && commits.length > 0 && <p className="placeholder">{t("history.pick")}</p>
        ) : (
          <>
            <div className="history-head">
              <span className="history-message">{selected.message}</span>
              <Button
                type="button"
                className="changes-approve-all"
                style={COMPACT}
                disabled={restoring || loaded === undefined || loaded.content === null}
                onClick={() => setConfirming(true)}
              >
                <Icon d={ICON.restore} />
                {t("history.restore")}
              </Button>
            </div>
            {loaded === undefined ? (
              !problem && <p className="placeholder">{t("diff.loading")}</p>
            ) : (
              <div className="history-body">
                {loaded.content === null && <p className="diff-note">{t("history.missing")}</p>}
                {loaded.content === props.current && <p className="diff-note">{t("diff.same")}</p>}
                <DiffCard path={path} base={loaded.content ?? ""} current={props.current} />
              </div>
            )}
          </>
        )}
      </div>
      <ConfirmDialog
        open={confirming}
        title={t("history.confirmTitle", { path })}
        body={t("history.confirmBody", { message: selected?.message ?? "" })}
        confirmLabel={t("history.restore")}
        onConfirm={() => void restore()}
        onCancel={() => setConfirming(false)}
      />
    </div>
  );
}
