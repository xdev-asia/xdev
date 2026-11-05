import type {
  Api,
  Automation,
  AutomationDispatch,
  AutomationInput,
  AutomationRun,
  AutomationsChanged,
  Describe,
  DispatchResult,
  FailureCode,
  RunFinish,
  RunUsage,
  RunsRange,
  RunsSummary,
  RunRow,
  RunTotals,
} from "./api";

type AutomationsApi = Pick<
  Api,
  | "automationsList"
  | "automationRuns"
  | "automationRunsSummary"
  | "automationCreate"
  | "automationUpdate"
  | "automationSetEnabled"
  | "automationDelete"
  | "automationRunNow"
  | "automationDescribe"
  | "automationValidateSchedule"
  | "automationNextRuns"
  | "automationUiReady"
  | "automationDispatchResult"
  | "automationRunFinish"
  | "onAutomationDispatch"
  | "onAutomationsChanged"
>;

export type MockAutomations = AutomationsApi & {
  /** What the backend's tick would send: a run for the UI to open a tab for. */
  __automationDispatch(e: AutomationDispatch): void;
  /** How many times the UI reported it is ready. */
  __automationReady(): number;
  /** Every dispatch result and run finish the UI reported, oldest first. */
  __automationReports(): { results: DispatchResult[]; finishes: RunFinish[] };
  /** Stores a run as the backend would, for list and history tests. */
  /** Sets what a run's agent session used; a run without it has no usage. */
  __automationUsage(runId: string, usage: RunUsage): void;
  __automationAddRun(run: Partial<AutomationRun> & Pick<AutomationRun, "automationId">): AutomationRun;
};

const MINUTE = 60_000;
const DEFAULT_NAME = "Untitled automation";
const DAYS = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

/** The demo's reading of a stored schedule: the presets `build` writes and their cron forms. */
export function mockDescribe(expr: string): Describe {
  const text = expr.trim();
  if (!text) return { kind: "invalid" };
  if (text.includes("=")) {
    const part = (key: string) => new RegExp(`(?:^|;)${key}=([^;]*)`).exec(text)?.[1];
    const freq = part("FREQ");
    const minute = Number(part("BYMINUTE") ?? 0);
    const hour = Number(part("BYHOUR") ?? 9);
    if (freq === "HOURLY") return { kind: "hourly", minute: Number(part("BYMINUTE") ?? 0) };
    if (freq === "DAILY") return { kind: "daily", hour, minute };
    if (freq === "WEEKLY") {
      const by = part("BYDAY") ?? "";
      if (by === "MO,TU,WE,TH,FR") return { kind: "weekdays", hour, minute };
      const dayOfWeek = DAYS.indexOf(by);
      if (dayOfWeek >= 0) return { kind: "weekly", hour, minute, dayOfWeek };
    }
    return { kind: "invalid" };
  }
  const fields = text.split(/\s+/);
  if (fields.length !== 5) return { kind: "invalid" };
  const [m, h, dom, mon, dow] = fields;
  const num = (s: string) => (/^\d+$/.test(s) ? Number(s) : null);
  if (dom === "*" && mon === "*") {
    if (h === "*" && num(m) !== null && dow === "*") return { kind: "hourly", minute: num(m)! };
    if (num(m) !== null && num(h) !== null) {
      if (dow === "*") return { kind: "daily", hour: num(h)!, minute: num(m)! };
      if (dow === "1-5") return { kind: "weekdays", hour: num(h)!, minute: num(m)! };
      if (num(dow) !== null && num(dow)! <= 7) return { kind: "weekly", hour: num(h)!, minute: num(m)!, dayOfWeek: num(dow)! % 7 };
    }
  }
  return { kind: "custom", expression: text };
}

/** The demo's next occurrences: one minute apart from the later of `dtstart` and now. Rust does the real math. */
function mockNext(from: number, count: number): number[] {
  const first = Math.floor(from / MINUTE) * MINUTE + MINUTE;
  return Array.from({ length: Math.max(0, Math.min(count, 5)) }, (_, i) => first + i * 60 * MINUTE);
}

const reject = (code: string, detail?: string): Promise<never> => Promise.reject(detail === undefined ? { code } : { code, detail });

const RANGE_MS: Record<RunsRange, number> = { "24h": 24 * 60 * MINUTE, "7d": 7 * 24 * 60 * MINUTE, "30d": 30 * 24 * 60 * MINUTE };

const cost = (usd: number): RunUsage["cost"] => ({ nanos: Math.round(usd * 1e9), unpriced: false, priced: true });

function addTotals(t: RunTotals, row: RunRow): void {
  t.runs += 1;
  if (row.status === "completed") t.ok += 1;
  if (row.status === "dispatch_failed") t.failed += 1;
  if (row.usage) {
    t.withUsage += 1;
    t.tokens += row.usage.tokensIn + row.usage.tokensOut + row.usage.tokensCache;
    t.cost = { nanos: t.cost.nanos + row.usage.cost.nanos, priced: t.cost.priced || row.usage.cost.priced, unpriced: t.cost.unpriced || row.usage.cost.unpriced };
  }
}

/** The demo's automations backend: an in-memory store; a test plays the tick through the `__automation` hooks. `demo` seeds two automations with a week of runs, some with usage and some without. */
export function createMockAutomations(options: { now?: () => number; demo?: boolean } = {}): MockAutomations {
  const now = options.now ?? (() => Date.now());
  let automations: Automation[] = [];
  let runs: AutomationRun[] = [];
  const usage = new Map<string, RunUsage>();
  let seq = 0;
  let ready = 0;
  const results: DispatchResult[] = [];
  const finishes: RunFinish[] = [];
  const dispatches = new Set<(e: AutomationDispatch) => void>();
  const changes = new Set<(e: AutomationsChanged) => void>();
  const on = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  const changed = (automationId: string | null) => {
    for (const cb of changes) cb({ automationId });
  };

  const normalize = (input: AutomationInput): AutomationInput => {
    const precheck = input.precheck && input.precheck.command.trim() ? { command: input.precheck.command.trim(), timeoutSeconds: Math.max(1, Math.min(600, input.precheck.timeoutSeconds)) } : null;
    return {
      ...input,
      name: input.name.trim() || DEFAULT_NAME,
      precheck,
      reuseSession: input.workspaceMode === "new_per_run" ? false : input.reuseSession,
      baseBranch: input.workspaceMode === "existing" ? null : input.baseBranch,
      worktree: input.workspaceMode === "new_per_run" ? null : input.worktree,
    };
  };

  const fill = (id: string, input: AutomationInput, at: number, prev?: Automation): Automation => ({
    ...input,
    id,
    nextRunAt: mockNext(Math.max(input.dtstart, at), 1)[0],
    lastRunAt: prev?.lastRunAt ?? null,
    createdAt: prev?.createdAt ?? at,
    updatedAt: at,
  });

  const lastRuns = () =>
    automations.flatMap((a) => {
      const run = runs.filter((r) => r.automationId === a.id).sort((x, y) => y.createdAt - x.createdAt || y.runNumber - x.runNumber)[0];
      return run ? [run] : [];
    });

  const newRun = (a: Automation, patch: Partial<AutomationRun> = {}): AutomationRun => {
    const runNumber = 1 + Math.max(0, ...runs.filter((r) => r.automationId === a.id).map((r) => r.runNumber));
    const at = now();
    const run: AutomationRun = {
      id: `run-${++seq}`,
      automationId: a.id,
      title: `${a.name} run ${runNumber}`,
      runNumber,
      scheduledFor: at,
      status: "dispatching",
      trigger: "manual",
      worktree: null,
      worktreeName: null,
      tabId: null,
      outputSnapshot: null,
      precheckResult: null,
      error: null,
      errorCode: null,
      errorParams: null,
      startedAt: at,
      dispatchedAt: null,
      finishedAt: null,
      createdAt: at,
      occurrenceCount: 1,
      lastOccurrenceAt: null,
      ...patch,
    };
    runs.push(run);
    return run;
  };

  const touch = (runId: string, patch: Partial<AutomationRun>) => {
    const run = runs.find((r) => r.id === runId);
    if (!run) return;
    Object.assign(run, patch);
    changed(run.automationId);
  };

  const summary = (range: RunsRange): RunsSummary => {
    const at = now();
    const since = at - RANGE_MS[range];
    const placed = (r: AutomationRun) => r.startedAt ?? r.scheduledFor;
    const rows: RunRow[] = [];
    for (const r of [...runs].sort((x, y) => placed(y) - placed(x))) {
      const a = automations.find((x) => x.id === r.automationId);
      if (!a || placed(r) < since || placed(r) > at) continue;
      rows.push({
        runId: r.id, automationId: a.id, automationName: a.name, startedAt: r.startedAt, finishedAt: r.finishedAt, status: r.status,
        durationMs: r.startedAt !== null && r.finishedAt !== null && r.finishedAt >= r.startedAt ? r.finishedAt - r.startedAt : null,
        agent: a.agent, usage: usage.get(r.id) ?? null,
      });
    }
    const empty = (): RunTotals => ({ runs: 0, ok: 0, failed: 0, withUsage: 0, tokens: 0, cost: { nanos: 0, unpriced: false, priced: false } });
    const totals = empty();
    const per = new Map<string, { automationName: string; totals: RunTotals }>();
    for (const row of rows) {
      addTotals(totals, row);
      const entry = per.get(row.automationId) ?? { automationName: row.automationName, totals: empty() };
      addTotals(entry.totals, row);
      per.set(row.automationId, entry);
    }
    return { range, since, runs: rows, byAutomation: [...per].map(([automationId, e]) => ({ automationId, ...e })), totals };
  };

  const api: MockAutomations = {
    async automationsList() {
      return structuredClone({ automations, lastRuns: lastRuns() });
    },
    async automationRuns(automationId) {
      return structuredClone(runs.filter((r) => r.automationId === automationId).sort((x, y) => y.runNumber - x.runNumber));
    },
    async automationRunsSummary(range) {
      return structuredClone(summary(range ?? "7d"));
    },
    async automationCreate(input) {
      const a = fill(`auto-${++seq}`, normalize(input), now());
      automations.push(a);
      changed(a.id);
      return structuredClone(a);
    },
    async automationUpdate(id, input) {
      const i = automations.findIndex((a) => a.id === id);
      if (i < 0) return reject("not_found");
      automations[i] = fill(id, normalize(input), now(), automations[i]);
      changed(id);
      return structuredClone(automations[i]);
    },
    async automationSetEnabled(id, enabled) {
      const a = automations.find((x) => x.id === id);
      if (!a) return reject("not_found");
      a.enabled = enabled;
      a.updatedAt = now();
      changed(id);
      return structuredClone(a);
    },
    async automationDelete(id) {
      if (!automations.some((a) => a.id === id)) return reject("not_found");
      automations = automations.filter((a) => a.id !== id);
      runs = runs.filter((r) => r.automationId !== id);
      changed(id);
    },
    async automationRunNow(id) {
      const a = automations.find((x) => x.id === id);
      if (!a) return reject("not_found");
      // Runs of one automation do not overlap, as in the backend.
      const open = new Set(["pending", "dispatching", "dispatched"]);
      if (runs.some((r) => r.automationId === id && open.has(r.status))) return reject("bad_arg", "previousRunActive");
      const run = newRun(a);
      a.lastRunAt = run.createdAt;
      changed(id);
      return structuredClone(run);
    },
    async automationDescribe(expr) {
      return mockDescribe(expr);
    },
    async automationValidateSchedule(expr) {
      const invalid = { key: "invalid", field: null, max: null };
      if (expr.includes("=")) return mockDescribe(expr).kind === "invalid" ? invalid : null;
      const fields = expr.trim().split(/\s+/);
      return fields.length === 5 && fields.every(Boolean) ? null : invalid;
    },
    async automationNextRuns(_expr, _tz, dtstart, count) {
      return mockNext(Math.max(dtstart, now()), count);
    },
    async automationUiReady() {
      ready++;
    },
    async automationDispatchResult(result) {
      results.push(structuredClone(result));
      if (result.status === "dispatched") {
        touch(result.runId, { status: "dispatched", tabId: result.tabId, dispatchedAt: now() });
        return;
      }
      const code: FailureCode = result.code;
      touch(result.runId, {
        status: code === "needsApproval" ? "skipped_needs_interactive_auth" : "dispatch_failed",
        errorCode: code,
        error: result.detail ?? code,
        finishedAt: now(),
      });
    },
    async automationRunFinish(finish) {
      finishes.push(structuredClone(finish));
      const at = now();
      touch(finish.runId, finish.completed
        ? { status: "completed", finishedAt: at, outputSnapshot: finish.output === null ? null : { content: finish.output, capturedAt: at, truncated: finish.truncated } }
        : { status: "dispatch_failed", finishedAt: at, errorCode: "agentNoCompletion", error: "The agent stopped before it finished." });
    },
    async onAutomationDispatch(cb) {
      return on(dispatches, cb);
    },
    async onAutomationsChanged(cb) {
      return on(changes, cb);
    },
    __automationDispatch: (e) => [...dispatches].forEach((cb) => cb(structuredClone(e))),
    __automationReady: () => ready,
    __automationReports: () => structuredClone({ results, finishes }),
    __automationUsage(runId, u) {
      usage.set(runId, structuredClone(u));
    },
    __automationAddRun(patch) {
      const a = automations.find((x) => x.id === patch.automationId);
      if (!a) throw new Error(`no automation ${patch.automationId}`);
      const run = newRun(a, patch);
      changed(a.id);
      return structuredClone(run);
    },
  };

  if (options.demo) {
    const at = now();
    const input = (name: string, agent: string): AutomationInput => ({
      name, prompt: "Run the checks and report.", precheck: null, agent, extraAgentArgs: null, repoId: "demo", workspaceMode: "existing",
      worktree: "/demo/repo", baseBranch: null, setupDecision: "inherit", reuseSession: false, timezone: "UTC", rrule: "FREQ=DAILY;BYHOUR=9;BYMINUTE=0",
      dtstart: at, enabled: true, missedRunGraceMinutes: 720,
    });
    const nightly = fill(`auto-${++seq}`, input("Nightly audit", "claude"), at);
    const triage = fill(`auto-${++seq}`, input("Issue triage", "codex"), at);
    automations.push(nightly, triage);
    const HOUR = 60 * MINUTE;
    const seed = (a: Automation, hoursAgo: number, status: AutomationRun["status"], minutes: number, u?: RunUsage) => {
      const start = at - hoursAgo * HOUR;
      const run = newRun(a, { status, startedAt: start, scheduledFor: start, createdAt: start, finishedAt: start + minutes * MINUTE, worktree: "/demo/repo", worktreeName: "repo", trigger: "scheduled" });
      if (u) usage.set(run.id, u);
    };
    seed(nightly, 3, "completed", 12, { tokensIn: 41_200, tokensOut: 9_800, tokensCache: 310_000, cost: cost(0.42) });
    seed(nightly, 27, "completed", 9, { tokensIn: 38_000, tokensOut: 7_100, tokensCache: 280_000, cost: cost(0.36) });
    seed(nightly, 51, "dispatch_failed", 1);
    seed(triage, 6, "completed", 4, { tokensIn: 12_400, tokensOut: 2_300, tokensCache: 0, cost: cost(0.009) });
    seed(triage, 30, "completed", 5);
    seed(triage, 100, "completed", 6, { tokensIn: 15_000, tokensOut: 3_000, tokensCache: 20_000, cost: cost(0.02) });
  }
  return api;
}
