import { expect, it } from "vitest";
import type { UpdatePhase } from "@/api";
import { INITIAL_CHECK, nextCheck, phaseLine, type CheckState } from "./useUpdateCheck";

const ready: UpdatePhase = { kind: "ready", version: "0.4.0", notes: null };

it("follows the phases Rust reports", () => {
  let s: CheckState = INITIAL_CHECK;
  expect(s.phase).toEqual({ kind: "idle" });
  s = nextCheck(s, { kind: "phase", phase: { kind: "checking" } });
  expect(s.phase.kind).toBe("checking");
  s = nextCheck(s, { kind: "phase", phase: ready });
  expect(s).toEqual({ phase: ready, restart: "idle" });
});

it("a phase that arrives while the install restarts does not hide it", () => {
  let s = nextCheck({ phase: ready, restart: "idle" }, { kind: "restarting" });
  expect(s.restart).toBe("restarting");
  s = nextCheck(s, { kind: "phase", phase: { kind: "up-to-date" } });
  expect(s.restart).toBe("restarting");
  expect(nextCheck(s, { kind: "restartFailed" }).restart).toBe("failed");
  expect(nextCheck(s, { kind: "restartDone" })).toEqual({ phase: { kind: "up-to-date" }, restart: "idle" });
});

it("a restart handed to the quit guard frees the button again", () => {
  const s = nextCheck({ phase: ready, restart: "restarting" }, { kind: "restartHanded" });
  expect(s).toEqual({ phase: ready, restart: "idle" });
});

it("a new phase clears an earlier failed restart", () => {
  const failed: CheckState = { phase: ready, restart: "failed" };
  expect(nextCheck(failed, { kind: "phase", phase: { kind: "checking" } }).restart).toBe("idle");
});

it("reads each phase as one line", () => {
  const line = (phase: UpdatePhase, restart: CheckState["restart"] = "idle") => phaseLine({ phase, restart });
  expect(line({ kind: "idle" })).toEqual({ key: "settings.general.updates.idle" });
  expect(line({ kind: "checking" })).toEqual({ key: "settings.general.updates.checking" });
  expect(line({ kind: "up-to-date" })).toEqual({ key: "settings.general.updates.upToDate" });
  expect(line({ kind: "downloading", version: "0.4.0", percent: 40 })).toEqual({ key: "settings.general.updates.downloading", vars: { version: "0.4.0", percent: 40 } });
  expect(line({ kind: "downloading", version: "0.4.0", percent: null })).toEqual({ key: "settings.general.updates.downloadingUnknown", vars: { version: "0.4.0" } });
  expect(line(ready)).toEqual({ key: "settings.general.updates.ready", vars: { version: "0.4.0" } });
  expect(line({ kind: "error", detail: "offline" })).toEqual({ key: "settings.general.updates.error" });
  expect(line(ready, "failed")).toEqual({ key: "settings.general.updates.restartFailed" });
});
