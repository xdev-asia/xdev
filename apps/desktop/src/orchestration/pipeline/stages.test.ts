import { describe, expect, it } from "vitest";
import type { Pipeline, StageRun } from "@/api";
import { actionsFor, currentIndex, gateText, isDone, joinCommand, presetStages, progress, splitCommand } from "./stages";

const stage = (name: string, status: StageRun["status"]): StageRun => ({ name, gate: { kind: "none" }, status, attempts: 0 });
const pipeline = (...statuses: StageRun["status"][]): Pipeline => ({
  id: "pl-1",
  name: "run",
  subject: "squad:s",
  worktree: "/w",
  createdMs: 1,
  stages: statuses.map((s, i) => stage(`s${i}`, s)),
});

describe("stages", () => {
  it("the current stage is the first that has not passed", () => {
    expect(currentIndex(pipeline("passed", "failed", "pending"))).toBe(1);
    expect(currentIndex(pipeline("passed", "passed"))).toBe(-1);
    expect(isDone(pipeline("passed"))).toBe(true);
    expect(progress(pipeline("passed", "failed", "pending"))).toEqual({ passed: 1, total: 3 });
  });

  it("offers hand off while running, retry after a failed gate, approve or decline while waiting", () => {
    expect(actionsFor(pipeline("running", "pending"))).toEqual(["handOff"]);
    expect(actionsFor(pipeline("passed", "failed", "pending"))).toEqual(["retry"]);
    expect(actionsFor(pipeline("passed", "waiting"))).toEqual(["approve", "decline"]);
    expect(actionsFor(pipeline("passed"))).toEqual([]);
  });

  it("splits a command line into words, keeping quoted spaces and empty words", () => {
    expect(splitCommand("cargo test -p 'my crate'")).toEqual(["cargo", "test", "-p", "my crate"]);
    expect(splitCommand('  sh -c "exit 1"  ')).toEqual(["sh", "-c", "exit 1"]);
    expect(splitCommand('a "" b')).toEqual(["a", "", "b"]);
    expect(splitCommand("   ")).toEqual([]);
    expect(splitCommand(joinCommand(["a b", "", "c"]))).toEqual(["a b", "", "c"]);
  });

  it("describes a gate", () => {
    expect(gateText({ kind: "none" })).toEqual({ key: "none" });
    expect(gateText({ kind: "approval", question: "?" })).toEqual({ key: "approval" });
    expect(gateText({ kind: "check", command: ["cargo", "test"] })).toEqual({ key: "check", command: "cargo test" });
  });

  it("the preset is implement, tests with a check when there is a command, and a person's review", () => {
    const names = { implement: "I", tests: "T", review: "R", question: "Q?" };
    expect(presetStages("cargo test", names)).toEqual([
      { name: "I", gate: { kind: "none" } },
      { name: "T", gate: { kind: "check", command: ["cargo", "test"] } },
      { name: "R", gate: { kind: "approval", question: "Q?" } },
    ]);
    expect(presetStages(" ", names)[1].gate).toEqual({ kind: "none" });
  });
});
