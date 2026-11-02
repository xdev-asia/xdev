import { afterEach, describe, expect, it, vi } from "vitest";
import { createMockApi, type Seat } from "./api";

const seats = (implement: string | null, lead: string | null = null): Seat[] => [
  { role: "lead", account: lead },
  { role: "implement", account: implement },
  { role: "tests", account: null },
  { role: "review", account: null },
];

describe("mock squads", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("has a demo squad in each state, and none without a repo", async () => {
    const api = createMockApi({});
    const states = (await api.squads()).map((s) => s.status);
    expect(states).toEqual(["idle", "running", "waiting", "done"]);
    const running = (await api.squads())[1].squad.id;
    expect((await api.squad(running)).run!.seats.implement!.state).toBe("working");
    expect(await createMockApi({}, { repo: false }).squads()).toEqual([]);
  });

  it("checks names, accounts and seats like the store", async () => {
    const api = createMockApi({});
    await expect(api.newSquad(" ", "/repo", seats("claude-2"), null)).rejects.toEqual({ code: "empty_name" });
    await expect(api.newSquad("T", "/repo", seats("ghost"), null)).rejects.toEqual({ code: "unknown_account" });
    const squad = await api.newSquad(" Team ", "/repo", seats(null), " pnpm  test ");
    expect(squad.name).toBe("Team");
    expect(squad.test).toEqual(["pnpm", "test"]);
    expect((await api.squads())[0].squad.id).toBe(squad.id);
    await expect(api.runSquad(squad.id, "Go")).rejects.toEqual({ code: "seat_vacant" });
    await expect(api.setSeat(squad.id, "boss", "codex-1")).rejects.toEqual({ code: "bad_role" });
    await expect(api.setSeat(squad.id, "implement", "ghost")).rejects.toEqual({ code: "unknown_account" });
    expect((await api.setSeat(squad.id, "implement", "codex-1")).squad.seats[1].account).toBe("codex-1");
    await expect(api.steerSquad(squad.id, "implement", "hi")).rejects.toEqual({ code: "no_run" });
    await expect(api.stopSquad(squad.id)).rejects.toEqual({ code: "no_run" });
  });

  it("runs, stops while running, resumes to done", async () => {
    vi.useFakeTimers();
    const api = createMockApi({}, { runDelayMs: 1000 });
    const squad = await api.newSquad("Team", "/repo", seats("codex-1", "claude-2"), null);
    const run = api.runSquad(squad.id, "Add a greeting");
    await vi.advanceTimersByTimeAsync(10);
    const during = await api.squad(squad.id);
    expect(during.status).toBe("running");
    expect(Object.values(during.run!.seats).filter((s) => s!.state === "working")).toHaveLength(1);
    await expect(api.runSquad(squad.id, "Again")).rejects.toEqual({ code: "busy" });
    await expect(api.setSeat(squad.id, "lead", null)).rejects.toEqual({ code: "busy" });

    expect((await api.steerSquad(squad.id, "lead", "keep it short")).run!.seats.lead!.queued).toEqual(["keep it short"]);
    expect((await api.stopSquad(squad.id)).status).toBe("stopped");
    expect((await run).status).toBe("stopped");

    const resumed = api.resumeSquad(squad.id);
    await vi.advanceTimersByTimeAsync(1000);
    const done = await resumed;
    expect(done.status).toBe("done");
    expect(done.run!.seats.tests!.state).toBe("skipped");
    expect(done.events.map((e) => e.kind)).toEqual(expect.arrayContaining(["start", "steer", "stop", "resume", "done"]));
    expect(await api.squadEvents(squad.id)).toHaveLength(done.eventCount);
  });

  it("answers a question put to the person, once", async () => {
    const api = createMockApi({});
    const waiting = (await api.squads()).find((s) => s.status === "waiting")!.squad.id;
    const [e] = (await api.squad(waiting)).run!.escalations;
    expect(e.to).toBe("person");
    await expect(api.answerSquad(waiting, e.id, " ")).rejects.toEqual({ code: "empty_text" });
    await expect(api.answerSquad(waiting, "e9", "docs/")).rejects.toEqual({ code: "not_found" });
    const done = await api.answerSquad(waiting, e.id, "docs/");
    expect(done.status).toBe("done");
    expect(done.run!.escalations[0].answer).toBe("docs/");
    await expect(api.answerSquad(waiting, e.id, "again")).rejects.toEqual({ code: "no_run" });
  });
});
