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
} from "./api";

type AutomationsApi = Pick<
  Api,
  | "automationsList"
  | "automationRuns"
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

/** The automations backend's demo: an in-memory store; a test plays the tick through the `__automation` hooks. */
export function createMockAutomations(options: { now?: () => number } = {}): MockAutomations {
  const now = options.now ?? (() => Date.now());
  let automations: Automation[] = [];
  let runs: AutomationRun[] = [];
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

  return {
    async automationsList() {
      return structuredClone({ automations, lastRuns: lastRuns() });
    },
    async automationRuns(automationId) {
      return structuredClone(runs.filter((r) => r.automationId === automationId).sort((x, y) => y.runNumber - x.runNumber));
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
      if (expr.includes("=")) return mockDescribe(expr).kind === "invalid" ? "invalid" : null;
      const fields = expr.trim().split(/\s+/);
      return fields.length === 5 && fields.every(Boolean) ? null : "invalid";
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
    __automationAddRun(patch) {
      const a = automations.find((x) => x.id === patch.automationId);
      if (!a) throw new Error(`no automation ${patch.automationId}`);
      const run = newRun(a, patch);
      changed(a.id);
      return structuredClone(run);
    },
  };
}
