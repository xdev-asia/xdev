import { Banner, Button, IconButton, ListRow, Skeleton, StatusDot, Switch } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type Api, type ApiError, type RepoView, type TaskSource, type TrackerItem, type TrackersView } from "@/api";
import { ghReasonText } from "@/issues/ghReason";
import { useI18n } from "@/i18n";
import { ago } from "@/workspace/ago";
import { pushToast } from "@/workspace/toastStore";
import type { StartRequest, StartWhere } from "@/tasks/board/boardModel";
import { StartTaskDialog } from "@/tasks/board/StartTaskDialog";
import { ALL_SHOWN, githubQueries, githubRows, loadShown, mergeGithub, saveShown, stateTone, type Shown } from "./trackerRows";
import { startTrackerItem } from "./trackerStart";
import "@/styles/trackers.css";

type T = ReturnType<typeof useI18n>["t"];

export interface TrackerSectionsProps {
  api: Api;
  repo: Pick<RepoView, "id" | "path">;
  agents: { value: string; label: string }[];
  current: { path: string; branch: string | null } | null;
  onStart(req: StartRequest): Promise<unknown>;
  /** Which sections show, for tests; otherwise the stored choice. */
  view?: { shown?: Partial<Shown> };
}

interface Loaded {
  rows: TrackerItem[];
  truncated: boolean;
}

type Pulls = { assigned: boolean; created: boolean; done: boolean };

const SOURCES: readonly TaskSource[] = ["github", "linear", "jira"];
const NAME: Record<TaskSource, string> = { github: "GitHub", linear: "Linear", jira: "Jira" };
const DEFAULT_PULLS: Pulls = { assigned: true, created: false, done: false };

/** The line for a failed tracker call; a rate limit with a wait names it. */
export function trackerErrorText(error: ApiError, t: T): string {
  if (error.code === "tracker_rate_limited" && error.detail && /^\d+$/.test(error.detail)) {
    return t("trackers.rateLimitedIn", { seconds: error.detail });
  }
  return t(`error.${error.code}`);
}

/** The GitHub, Linear and Jira issues of this repo's List tab, one section each. */
export function TrackerSections(props: TrackerSectionsProps): JSX.Element {
  const { api, repo } = props;
  const { t } = useI18n();
  const [status, setStatus] = useState<TrackersView | null>(null);
  const [shown, setShown] = useState<Shown>(() => ({ ...loadShown(), ...props.view?.shown }));
  const [starting, setStarting] = useState<TrackerItem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    api
      .trackersStatus()
      .then((v) => current && setStatus(v))
      .catch(() => current && setStatus(null));
    return () => {
      current = false;
    };
  }, [api]);

  function setOne(source: TaskSource, on: boolean): void {
    const next = { ...ALL_SHOWN, ...shown, [source]: on };
    setShown(next);
    saveShown(next);
  }

  async function start(row: TrackerItem, where: StartWhere, agent: string | null): Promise<void> {
    setBusy(true);
    try {
      await startTrackerItem(
        {
          worktreeCreate: (id, name, from, request) => api.worktreeCreate(id, name, from, request),
          worktreeDetails: (path, patch) => api.worktreeDetails(path, patch),
          onStart: props.onStart,
          current: props.current,
        },
        repo,
        row,
        where,
        agent,
      );
      setStarting(null);
    } catch (e) {
      pushToast({ id: "tracker-start-failed", text: `${t("board.start.failed")} ${t(`error.${toApiError(e).code}`)}` });
    } finally {
      setBusy(false);
    }
  }

  const connected: Record<TaskSource, boolean> = {
    github: true,
    linear: status?.linear.connected ?? false,
    jira: status?.jira.connected ?? false,
  };
  const pulls: Record<TaskSource, Pulls> = {
    github: status?.github ?? DEFAULT_PULLS,
    linear: status?.linear.pulls ?? DEFAULT_PULLS,
    jira: status?.jira.pulls ?? DEFAULT_PULLS,
  };

  return (
    <div className="trk-sections">
      {SOURCES.filter((s) => connected[s]).map((source) => (
        <TrackerSection
          key={source}
          api={api}
          repoId={repo.id}
          source={source}
          pullsKey={JSON.stringify(pulls[source])}
          pulls={pulls[source]}
          shown={shown[source]}
          onShown={(on) => setOne(source, on)}
          onStart={setStarting}
        />
      ))}
      {starting ? (
        <StartTaskDialog
          agents={props.agents}
          defaultAgent={null}
          hasCurrent={!!props.current}
          busy={busy}
          onStart={(where, agent) => void start(starting, where, agent)}
          onClose={() => setStarting(null)}
        />
      ) : null}
    </div>
  );
}

export interface SectionProps {
  api: Api;
  repoId: string;
  source: TaskSource;
  pulls: Pulls;
  /** Changes when the checklist does, so the section reloads. */
  pullsKey: string;
  shown: boolean;
  onShown(on: boolean): void;
  onStart(row: TrackerItem): void;
}

function load(api: Api, repoId: string, source: TaskSource, pulls: Pulls): Promise<Loaded> {
  if (source === "github") {
    return Promise.all(githubQueries(pulls).map((q) => api.issuesList(repoId, q))).then((lists) => ({
      rows: githubRows(mergeGithub(lists)),
      truncated: false,
    }));
  }
  return api.trackerList(source).then((list) => ({ rows: list.items, truncated: list.truncated }));
}

function stateText(row: TrackerItem, t: T): string {
  if (row.source !== "github") return row.state;
  return t(row.stateKind === "done" ? "trackers.state.closed" : "trackers.state.open");
}

export function TrackerSection(props: SectionProps): JSX.Element | null {
  const { api, source, shown } = props;
  const { t } = useI18n();
  const name = NAME[source];
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!shown) return;
    let current = true;
    setLoaded(null);
    setError(null);
    load(api, props.repoId, source, props.pulls)
      .then((v) => current && setLoaded(v))
      .catch((e: unknown) => current && setError(toApiError(e)));
    return () => {
      current = false;
    };
    // `pullsKey` stands for `pulls`, which is a new object on every draw.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, props.repoId, source, shown, tick, props.pullsKey]);

  // A repo without a GitHub remote has no GitHub issues to show.
  if (source === "github" && error?.code === "not_github") return null;

  const title = t(`trackers.section.${source}`);
  const now = Date.now();
  return (
    <section className="trk-section" aria-label={title}>
      <header className="trk-head">
        <h3 className="trk-title">
          {title}
          {loaded ? (
            <span className="trk-count" aria-label={t("trackers.count", { count: loaded.rows.length })}>
              {loaded.rows.length}
            </span>
          ) : null}
        </h3>
        <div className="trk-tools">
          <Switch checked={shown} onChange={(e) => props.onShown(e.target.checked)} label={t("trackers.show", { source: name })} />
          <IconButton icon="refresh" label={t("trackers.refresh", { source: name })} disabled={!shown} onClick={() => setTick((n) => n + 1)} />
        </div>
      </header>
      {!shown ? null : error ? (
        source === "github" ? (
          <p className="trk-note">{ghReasonText(error, t)}</p>
        ) : (
          <Banner
            tone="danger"
            title={trackerErrorText(error, t)}
            action={
              <Button variant="secondary" type="button" onClick={() => setTick((n) => n + 1)}>
                {t("trackers.retry")}
              </Button>
            }
          />
        )
      ) : loaded === null ? (
        <Skeleton lines={3} announce labels={{ loading: t("trackers.loading", { source: name }) }} />
      ) : loaded.rows.length === 0 ? (
        <p className="trk-note">{t("trackers.empty")}</p>
      ) : (
        <>
          <ul className="trk-list">
            {loaded.rows.map((row) => (
              <ListRow
                key={`${row.source}:${row.id}`}
                as="li"
                leading={<StatusDot tone={stateTone(row.stateKind)} />}
                title={
                  <>
                    <span className="trk-key">{row.key}</span> {row.title}
                  </>
                }
                meta={[stateText(row, t), row.assignee ?? t("trackers.unassigned"), ago(Date.parse(row.updatedAt), now, t)].join(" · ")}
                trailing={
                  <>
                    <IconButton icon="external" label={t("trackers.open", { key: row.key })} onClick={() => void api.openUrl(row.url)} />
                    <IconButton icon="play" label={t("trackers.start", { key: row.key })} onClick={() => props.onStart(row)} />
                  </>
                }
              />
            ))}
          </ul>
          {loaded.truncated ? <p className="trk-note">{t("trackers.truncated", { count: 200 })}</p> : null}
        </>
      )}
    </section>
  );
}
