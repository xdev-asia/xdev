import type { JiraMode, TaskSource, TrackerConnect, TrackerItem, TrackerKind, TrackerList, TrackerPulls, TrackersView } from "@xdev/bindings";
import type { Api, ApiError } from "./api";

type TrackersApi = Pick<Api, "trackersStatus" | "trackerConnect" | "trackerDisconnect" | "trackerPullsSet" | "trackerList">;

const DEFAULT_PULLS: TrackerPulls = { assigned: true, created: false, done: false };

const LINEAR_ITEMS: TrackerItem[] = [
  {
    source: "linear",
    id: "lin-1",
    key: "ENG-12",
    title: "Fix login redirect",
    state: "In Progress",
    stateKind: "inProgress",
    assignee: "Ada",
    url: "https://linear.app/example/issue/ENG-12",
    updatedAt: "2026-11-06T09:00:00.000Z",
  },
  {
    source: "linear",
    id: "lin-2",
    key: "ENG-9",
    title: "Retire the old importer",
    state: "Done",
    stateKind: "done",
    assignee: "Ada",
    url: "https://linear.app/example/issue/ENG-9",
    updatedAt: "2026-11-05T09:00:00.000Z",
  },
  {
    source: "linear",
    id: "lin-3",
    key: "ENG-15",
    title: "Document the export format",
    state: "Todo",
    stateKind: "todo",
    assignee: null,
    url: "https://linear.app/example/issue/ENG-15",
    updatedAt: "2026-11-04T09:00:00.000Z",
  },
];

const JIRA_ITEMS: TrackerItem[] = [
  {
    source: "jira",
    id: "10001",
    key: "ACME-7",
    title: "Timeout on the report page",
    state: "In Progress",
    stateKind: "inProgress",
    assignee: "Ada",
    url: "https://acme.atlassian.net/browse/ACME-7",
    updatedAt: "2026-11-06T10:00:00.000Z",
  },
];

function fail(code: ApiError["code"]): Promise<never> {
  const error: ApiError = { code };
  return Promise.reject(error);
}

/** Host of a bare Jira Cloud name or URL, or null when it is not an Atlassian Cloud site. */
function cloudBase(value: string): string | null {
  const raw = value.trim();
  if (raw === "") return null;
  const host = /^https:\/\//i.test(raw) ? raw.replace(/^https:\/\//i, "").replace(/\/+$/, "") : raw;
  const name = host.replace(/\.atlassian\.net$/i, "");
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/i.test(name)) return null;
  return `https://${name.toLowerCase()}.atlassian.net`;
}

function serverBase(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Settings → Task trackers and the tracker lists, in memory. Linear starts connected. */
export function createMockTrackers(): TrackersApi {
  let github = { ...DEFAULT_PULLS };
  let linear = { connected: true, account: "Ada" as string | null, pulls: { ...DEFAULT_PULLS } };
  let jira = {
    connected: false,
    account: null as string | null,
    mode: null as JiraMode | null,
    base: null as string | null,
    email: null as string | null,
    pulls: { ...DEFAULT_PULLS },
  };
  const view = (): TrackersView => ({
    github: { ...github },
    linear: { ...linear, pulls: { ...linear.pulls } },
    jira: { ...jira, pulls: { ...jira.pulls } },
  });
  // A source never ends with every box off.
  const normal = (p: TrackerPulls): TrackerPulls => (p.assigned || p.created ? { ...p } : { ...p, assigned: true });

  return {
    async trackersStatus() {
      return view();
    },
    async trackerConnect(input: TrackerConnect) {
      if (input.token.trim() === "") return fail("empty_key");
      if (input.kind === "linear") {
        linear = { ...linear, connected: true, account: "Ada" };
        return view();
      }
      const cloud = input.kind === "jiraCloud";
      if (cloud && input.email.trim() === "") return fail("empty_key");
      const base = cloud ? cloudBase(input.url) : serverBase(input.url);
      if (base === null) return fail("tracker_bad_url");
      jira = {
        ...jira,
        connected: true,
        account: "Ada",
        mode: cloud ? "cloud" : "server",
        base,
        email: cloud ? input.email.trim() : null,
      };
      return view();
    },
    async trackerDisconnect(kind: TrackerKind) {
      if (kind === "linear") linear = { ...linear, connected: false, account: null };
      else jira = { ...jira, connected: false, account: null, mode: null, base: null, email: null };
      return view();
    },
    async trackerPullsSet(source: TaskSource, pulls: TrackerPulls) {
      const next = normal(pulls);
      if (source === "github") github = next;
      else if (source === "linear") linear = { ...linear, pulls: next };
      else jira = { ...jira, pulls: next };
      return view();
    },
    async trackerList(kind: TrackerKind): Promise<TrackerList> {
      const on = kind === "linear" ? linear.connected : jira.connected;
      if (!on) return fail("tracker_not_configured");
      return { items: (kind === "linear" ? LINEAR_ITEMS : JIRA_ITEMS).map((i) => ({ ...i })), truncated: false };
    },
  };
}
