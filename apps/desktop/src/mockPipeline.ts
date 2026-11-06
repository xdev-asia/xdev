import type { Api, ApiError, Matched, MatchRow, Pipeline, RevealTab, RouteTarget, SwarmRow } from "./api";

type PipelineApi = Pick<
  Api,
  | "routingMatch"
  | "pipelines"
  | "newPipeline"
  | "pipelineHandOff"
  | "pipelineRetry"
  | "pipelineDecide"
  | "removePipeline"
  | "swarmStart"
  | "swarmWorkers"
  | "swarmStopAll"
  | "swarmOpenTab"
  | "onOrchestrationRevealTab"
>;

export type MockPipeline = PipelineApi & {
  // The exit codes the next check gates see, oldest first; a check with none left exits 0.
  __pipelineExits(codes: number[]): void;
  // The tabs `swarmOpenTab` was asked to show, oldest first.
  __swarmOpened(): string[];
};

export const SWARM_DEFAULT = 4;
export const SWARM_MAX = 12;
const DEFAULT_TARGET: RouteTarget = { agent: "claude" };

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  return Promise.reject(detail === undefined ? { code } : { code, detail });
}

// Lower-cased words joined by one space and padded, as the backend does, so a phrase is found between word edges only.
function words(text: string): string {
  const found = text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return ` ${found.map((w) => w.toLowerCase()).join(" ")}${found.length ? " " : ""}`;
}

export function rowMatches(row: MatchRow, sentence: string, label: string | null): boolean {
  const own = row.label?.trim();
  if (own && label !== null && own.toLowerCase() === label.trim().toLowerCase()) return true;
  const text = words(sentence);
  return row.keywords.some((k) => words(k).trim() !== "" && text.includes(words(k)));
}

function clean(t: RouteTarget): RouteTarget {
  const out: RouteTarget = { agent: t.agent.trim() };
  if (t.model?.trim()) out.model = t.model.trim();
  if (t.pool?.trim()) out.pool = t.pool.trim();
  return out;
}

export function createMockPipeline(): MockPipeline {
  const store = new Map<string, Pipeline>();
  const exits: number[] = [];
  const opened: string[] = [];
  const revealers = new Set<(e: RevealTab) => void>();
  const swarms = new Map<string, SwarmRow[]>();
  let nextPipeline = 1;
  let nextSwarm = 1;

  const get = (id: string): Pipeline => {
    const p = store.get(id);
    if (!p) throw { code: "orchestration", detail: `not_found: no pipeline ${id}` } satisfies ApiError;
    return p;
  };
  const current = (p: Pipeline): number => p.stages.findIndex((s) => s.status !== "passed");
  const settle = (p: Pipeline, i: number, verdict: "passed" | "failed" | "waiting", why?: string): void => {
    const s = p.stages[i];
    delete s.gateId;
    if (verdict === "passed") {
      s.status = "passed";
      delete s.reason;
      if (p.stages[i + 1]) p.stages[i + 1].status = "running";
    } else if (verdict === "failed") {
      s.status = "failed";
      s.reason = why ?? "failed";
    } else {
      s.status = "waiting";
      if (s.gate.kind === "approval") s.reason = s.gate.question;
      s.gateId = `gate_mock${i}`;
    }
  };
  const handOff = (id: string, retry: boolean): Pipeline => {
    const p = get(id);
    const i = current(p);
    const invalid = (m: string) => ({ code: "orchestration", detail: `invalid_transition: ${m}` }) satisfies ApiError;
    if (i < 0) throw invalid("every stage has passed");
    const s = p.stages[i];
    if (retry && s.status !== "failed") throw invalid("no stage has failed its gate");
    if (s.status !== "running" && s.status !== "failed") throw invalid(`${s.name} is waiting on its gate`);
    s.attempts += 1;
    const gate = s.gate;
    if (gate.kind === "none") settle(p, i, "passed");
    else if (gate.kind === "approval") settle(p, i, "waiting");
    else {
      const code = exits.shift() ?? 0;
      settle(p, i, code === 0 ? "passed" : "failed", `${gate.command[0]} exit ${code}: 1 test failed`);
    }
    return p;
  };
  const snap = (p: Pipeline): Pipeline => structuredClone(p);

  return {
    async routingMatch(routing, sentence, label): Promise<Matched> {
      const rows = routing.table ?? [];
      const at = rows.findIndex((r) => rowMatches(r, sentence, label));
      if (at >= 0) return { row: at, target: clean(rows[at].target) };
      return { row: null, target: clean(routing.fallback ?? DEFAULT_TARGET) };
    },
    async pipelines(subject) {
      return [...store.values()].filter((p) => subject === null || p.subject === subject).reverse().map(snap);
    },
    async newPipeline(name, subject, worktree, stages) {
      if (stages.length === 0 || stages.length > 12) return reject("orchestration", "bad_request: a pipeline has 1 to 12 stages");
      if (stages.some((s) => s.name.trim() === "")) return reject("orchestration", "bad_request: a stage needs a name");
      const id = `pl-mock${nextPipeline++}`;
      const p: Pipeline = {
        id,
        name: name.trim(),
        subject,
        worktree,
        createdMs: Date.now(),
        stages: stages.map((s, n) => ({ name: s.name.trim(), gate: structuredClone(s.gate), status: n === 0 ? "running" : "pending", attempts: 0 })),
      };
      store.set(id, p);
      return snap(p);
    },
    async pipelineHandOff(id) {
      return snap(handOff(id, false));
    },
    async pipelineRetry(id) {
      return snap(handOff(id, true));
    },
    async pipelineDecide(id, approved, note) {
      const p = get(id);
      const i = current(p);
      if (i < 0 || p.stages[i].status !== "waiting") return reject("orchestration", "invalid_transition: no stage waits on an approval");
      settle(p, i, approved ? "passed" : "failed", note?.trim() ? `declined: ${note.trim()}` : "declined");
      return snap(p);
    },
    async removePipeline(id) {
      get(id);
      store.delete(id);
    },
    async swarmStart(goal, count, agent, tab, worktree) {
      if (goal.trim() === "") return reject("orchestration", "bad_request: a swarm needs a goal");
      if (tab === null && (worktree ?? "").trim() === "") return reject("orchestration", "bad_request: a swarm needs the tab or the worktree it starts from");
      const size = Math.min(Math.max(count ?? SWARM_DEFAULT, 1), SWARM_MAX);
      const run = `run_mock${nextSwarm++}`;
      const rows: SwarmRow[] = Array.from({ length: size }, (_, n) => ({
        dispatch: `disp_${run}_${n + 1}`,
        tab: `${run}-w${n + 1}`,
        agent: agent.trim(),
        state: "ready",
        lastLine: `Working on part ${n + 1} of ${size}`,
      }));
      swarms.set(run, rows);
      return { run, started: { size, workers: rows.map((r) => ({ dispatch: r.dispatch, tab: r.tab ?? "" })), failed: [] } };
    },
    async swarmWorkers(run) {
      return structuredClone(swarms.get(run) ?? []);
    },
    async swarmStopAll(run) {
      const rows = swarms.get(run) ?? [];
      const live = rows.filter((r) => r.state !== "stopped");
      for (const r of live) r.state = "stopped";
      return { stopped: live.map((r) => r.dispatch), failed: [] };
    },
    async swarmOpenTab(tab) {
      opened.push(tab);
      for (const cb of [...revealers]) cb({ tab });
    },
    async onOrchestrationRevealTab(cb) {
      revealers.add(cb);
      return () => void revealers.delete(cb);
    },
    __pipelineExits: (codes) => void exits.splice(0, exits.length, ...codes),
    __swarmOpened: () => [...opened],
  };
}
