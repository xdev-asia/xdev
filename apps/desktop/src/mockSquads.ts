import type { Account, Api, ApiError, Role, Seat, SeatState, Squad, SquadEvent, SquadRun, SquadStatus, SquadView } from "./api";

type SquadApi = Pick<
  Api,
  | "squads"
  | "squad"
  | "newSquad"
  | "setSeat"
  | "removeSquad"
  | "runSquad"
  | "answerSquad"
  | "steerSquad"
  | "resumeSquad"
  | "stopSquad"
  | "squadEvents"
>;

export type MockSquadOptions = {
  // Repo for the demo squads; none are made when the open folder has no repo.
  defaultRepo: string | null;
  accounts(): Account[];
  // How long a fake run takes, so the preview shows the running state.
  runDelayMs?: number;
};

export const ROLES: readonly Role[] = ["lead", "implement", "tests", "review"];
const RECENT = 20;
const MIN = 60;
const WINDOW = 200_000;

type Entry = { squad: Squad; run: SquadRun | null; events: SquadEvent[] };

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function isRole(role: string): role is Role {
  return (ROLES as readonly string[]).includes(role);
}

function seat(state: SeatState["state"], used: number | null, last = ""): SeatState {
  return { state, session: used === null ? null : `demo-${state}-${used}`, context: used === null ? null : { used, window: WINDOW }, last, wait: null, queued: [] };
}

function status(run: SquadRun | null): SquadStatus {
  if (run === null) return "idle";
  if (run.step === "done") return "done";
  if (run.stopped) return "stopped";
  if (Object.values(run.seats).some((s) => s?.state === "needs_you")) return "waiting";
  return "running";
}

function freshRun(squad: Squad, goal: string, task: string): SquadRun {
  const seats: SquadRun["seats"] = {};
  for (const s of squad.seats) seats[s.role] = seat(s.account === null ? "vacant" : "idle", null);
  return { squad: squad.id, task, goal, step: "plan", round: 1, seats, escalations: [], plan: null, notes: null, test: null, violations: 0, stopped: false, started: now(), ended: null };
}

function demo(repo: string): Entry[] {
  const t = now();
  const squad = (id: string, name: string, accounts: (string | null)[], ago: number): Squad => ({
    id,
    name,
    repo,
    seats: ROLES.map((role, i) => ({ role, account: accounts[i] ?? null })) as Squad["seats"],
    test: null,
    created: t - ago,
  });
  const ev = (ago: number, kind: string, role: Role | null, text: string): SquadEvent => (role === null ? { at: t - ago, kind, text } : { at: t - ago, kind, role, text });

  const feature = squad("20261102-1000-feature-squad", "Feature squad", ["claude-2", "codex-1", null, "claude-3"], 3 * 60 * MIN);
  const featureRun = freshRun(feature, "Add retry to fetchJson", "20261102-1100-retry");
  featureRun.started = t - 25 * MIN;
  featureRun.step = "implement";
  featureRun.plan = "1. Wrap fetch in a loop.\n2. Stop after three tries.";
  featureRun.seats.lead = seat("done", 64_000, featureRun.plan);
  featureRun.seats.implement = seat("working", 150_000, "Editing src/retry.ts");
  featureRun.seats.review = seat("idle", null);
  featureRun.violations = 1;

  const docs = squad("20261102-0800-docs-squad", "Docs squad", ["claude-2", "claude-3", "codex-1", null], 5 * 60 * MIN);
  const docsRun = freshRun(docs, "Document the export command", "20261102-0830-export-docs");
  docsRun.started = t - 40 * MIN;
  docsRun.step = "implement";
  docsRun.seats.lead = seat("done", 186_000, "Asked the person which folder to use.");
  docsRun.seats.implement = { ...seat("needs_you", 120_000, "Which folder should the page go in?"), wait: { kind: "escalation", id: "e1" } };
  docsRun.escalations = [
    { id: "e1", from: "implement", to: "person", step: "implement", question: "Which folder should the page go in: docs/ or guides/?", note: "Not in the plan; the person decides.", answer: null, at: t - 12 * MIN, answered: null },
  ];

  const release = squad("20261101-0900-release-squad", "Release squad", ["claude-3", "claude-2", "codex-1", "claude-3"], 30 * 60 * MIN);
  const releaseRun = freshRun(release, "Bump the version to 0.2", "20261101-0930-version");
  releaseRun.started = t - 20 * 60 * MIN;
  releaseRun.ended = t - 19 * 60 * MIN;
  releaseRun.step = "done";
  for (const role of ROLES) releaseRun.seats[role] = seat("done", 40_000, "Done.");
  releaseRun.notes = "Looks right.";

  const fresh = squad("20261102-1200-bug-squad", "Bug squad", [null, "claude-2", null, null], 10 * MIN);

  return [
    { squad: fresh, run: null, events: [] },
    {
      squad: feature,
      run: featureRun,
      events: [
        ev(25 * MIN, "start", null, featureRun.goal),
        ev(25 * MIN, "step", "lead", "plan"),
        ev(22 * MIN, "reply", "lead", featureRun.plan),
        ev(21 * MIN, "step", "implement", "implement"),
      ],
    },
    {
      squad: docs,
      run: docsRun,
      events: [
        ev(40 * MIN, "start", null, docsRun.goal),
        ev(30 * MIN, "step", "implement", "implement"),
        ev(12 * MIN, "escalation", "implement", docsRun.escalations[0].question),
        ev(12 * MIN, "needs_you", "implement", "waiting for your answer"),
      ],
    },
    {
      squad: release,
      run: releaseRun,
      events: [ev(20 * 60 * MIN, "start", null, releaseRun.goal), ev(19 * 60 * MIN, "done", null, "ready for review")],
    },
  ];
}

// In-memory squads that follow the agent crate's rules: one run at a time, a vacant implement seat
// cannot run, questions to the person wait for an answer, and stop pauses the run.
export function createMockSquads(options: MockSquadOptions): SquadApi {
  const entries: Entry[] = options.defaultRepo === null ? [] : demo(options.defaultRepo);
  // Stops a run in progress, like the store's stop file.
  const halts = new Map<string, () => void>();
  let made = 0;

  function find(id: string): Entry | undefined {
    return entries.find((e) => e.squad.id === id);
  }

  function view(e: Entry): SquadView {
    return structuredClone({ squad: e.squad, run: e.run, status: status(e.run), events: e.events.slice(-RECENT), eventCount: e.events.length });
  }

  function event(e: Entry, kind: string, role: Role | null, text: string): void {
    e.events.push(role === null ? { at: now(), kind, text } : { at: now(), kind, role, text });
  }

  function known(account: string): boolean {
    return options.accounts().some((a) => a.name === account);
  }

  function halt(e: Entry): void {
    const run = e.run;
    if (run === null || run.stopped || run.step === "done") return;
    run.stopped = true;
    for (const s of Object.values(run.seats)) if (s?.state === "working") s.state = "idle";
    event(e, "stop", null, "stopped by the person");
  }

  // Works the remaining seats in one go after the delay, unless stopped first.
  async function drive(e: Entry): Promise<SquadView> {
    const run = e.run as SquadRun;
    run.stopped = false;
    const next = ROLES.find((r) => run.seats[r]?.state === "idle") ?? "implement";
    const working = run.seats[next] as SeatState;
    working.state = "working";
    run.step = next === "lead" ? "plan" : next;
    event(e, "step", next, run.step);
    const stopped = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), options.runDelayMs ?? 0);
      halts.set(e.squad.id, () => {
        clearTimeout(timer);
        resolve(true);
      });
    });
    halts.delete(e.squad.id);
    if (stopped || run.stopped) return view(e);
    for (const role of ROLES) {
      const s = run.seats[role] as SeatState;
      if (s.state === "vacant") {
        if (role !== "lead") s.state = "skipped";
        continue;
      }
      s.state = "done";
      s.session = s.session ?? `demo-session-${role}`;
      s.context = { used: Math.min(WINDOW, (s.context?.used ?? 0) + 30_000), window: WINDOW };
      s.last = role === "review" ? "Looks right." : "Done.";
      s.queued = [];
    }
    run.step = "done";
    run.ended = now();
    event(e, "done", null, "ready for review");
    return view(e);
  }

  return {
    async squads() {
      return entries.map((e) => structuredClone({ squad: e.squad, status: status(e.run) }));
    },
    async squad(id) {
      const e = find(id);
      return e === undefined ? reject("not_found") : view(e);
    },
    async newSquad(name, repo, seats: Seat[], test) {
      if (name.trim() === "") return reject("empty_name");
      if (repo.trim() === "") return reject("no_repo");
      for (const s of seats) if (s.account !== null && s.account.trim() !== "" && !known(s.account.trim())) return reject("unknown_account");
      const parts = (test ?? "").split(/\s+/).filter(Boolean);
      made += 1;
      const squad: Squad = {
        id: `20261102-13${String(made).padStart(2, "0")}-${name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-")}`,
        name: name.trim(),
        repo,
        seats: ROLES.map((role) => {
          const account = seats.find((s) => s.role === role)?.account?.trim() ?? "";
          return { role, account: account === "" ? null : account };
        }) as Squad["seats"],
        test: parts.length === 0 ? null : parts,
        created: now(),
      };
      entries.unshift({ squad, run: null, events: [] });
      return structuredClone(squad);
    },
    async setSeat(id, role, account) {
      const e = find(id);
      if (e === undefined) return reject("not_found");
      if (!isRole(role)) return reject("bad_role");
      const name = account?.trim() ?? "";
      if (name !== "" && !known(name)) return reject("unknown_account");
      if (status(e.run) === "running") return reject("busy");
      const s = e.squad.seats.find((x) => x.role === role) as Seat;
      s.account = name === "" ? null : name;
      event(e, "seat", role, name === "" ? "vacant" : name);
      return view(e);
    },
    async removeSquad(id) {
      const index = entries.findIndex((e) => e.squad.id === id);
      if (index === -1) return reject("not_found");
      if (status(entries[index].run) === "running") return reject("busy");
      entries.splice(index, 1);
    },
    async runSquad(id, goal) {
      const e = find(id);
      if (goal.trim() === "") return reject("empty_goal");
      if (e === undefined) return reject("not_found");
      if (e.squad.seats[1].account === null) return reject("seat_vacant");
      const state = status(e.run);
      if (state === "running" || state === "waiting") return reject("busy");
      e.run = freshRun(e.squad, goal.trim(), `${e.squad.id}-run-${e.events.length}`);
      event(e, "start", null, e.run.goal);
      return drive(e);
    },
    async answerSquad(id, escalation, text) {
      if (text.trim() === "") return reject("empty_text");
      const e = find(id);
      if (e === undefined) return reject("not_found");
      if (e.run === null || e.run.step === "done") return reject("no_run");
      if (halts.has(id)) return reject("busy");
      const esc = e.run.escalations.find((x) => x.id === escalation);
      if (esc === undefined) return reject("not_found");
      if (esc.to !== "person" || esc.answered !== null) return reject("not_waiting");
      esc.answer = text.trim();
      esc.answered = now();
      const s = e.run.seats[esc.from] as SeatState;
      if (s.wait?.kind === "escalation" && s.wait.id === escalation) {
        s.state = "idle";
        s.wait = null;
      }
      event(e, "answer", esc.from, esc.answer);
      return drive(e);
    },
    async steerSquad(id, role, text) {
      if (text.trim() === "") return reject("empty_text");
      const e = find(id);
      if (e === undefined) return reject("not_found");
      if (!isRole(role)) return reject("bad_role");
      if (e.squad.seats.find((s) => s.role === role)?.account === null) return reject("seat_vacant");
      if (e.run === null || e.run.step === "done") return reject("no_run");
      const s = e.run.seats[role] as SeatState;
      event(e, "steer", role, text.trim());
      // A seat that is working gets the words after its agent ends.
      if (status(e.run) === "running") {
        s.queued.push(text.trim());
        return view(e);
      }
      s.last = text.trim();
      return view(e);
    },
    async resumeSquad(id) {
      const e = find(id);
      if (e === undefined) return reject("not_found");
      if (e.run === null || e.run.step === "done") return reject("no_run");
      if (halts.has(id) || status(e.run) === "running") return reject("busy");
      event(e, "resume", null, "");
      // Questions still wait for an answer.
      if (e.run.escalations.some((x) => x.to === "person" && x.answered === null)) {
        e.run.stopped = false;
        return view(e);
      }
      return drive(e);
    },
    async stopSquad(id) {
      const e = find(id);
      if (e === undefined) return reject("not_found");
      if (e.run === null || e.run.step === "done") return reject("no_run");
      halts.get(id)?.();
      halt(e);
      return view(e);
    },
    async squadEvents(id) {
      const e = find(id);
      return e === undefined ? reject("not_found") : structuredClone(e.events);
    },
  };
}
