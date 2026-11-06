import type { GateKind, Pipeline, StageSpec, StageStatus } from "@/api";

export type StageAction = "handOff" | "retry" | "approve" | "decline";

/** The first stage that has not passed; -1 once every one has. */
export function currentIndex(p: Pipeline): number {
  return p.stages.findIndex((s) => s.status !== "passed");
}

/** What the person can do about the current stage: its work is handed on, a failed gate is retried, an approval is answered. */
export function actionsFor(p: Pipeline): StageAction[] {
  const i = currentIndex(p);
  if (i < 0) return [];
  switch (p.stages[i].status) {
    case "running":
      return ["handOff"];
    case "failed":
      return ["retry"];
    case "waiting":
      return ["approve", "decline"];
    default:
      return [];
  }
}

/** `passed` stages out of all, for a summary line. */
export function progress(p: Pipeline): { passed: number; total: number } {
  return { passed: p.stages.filter((s) => s.status === "passed").length, total: p.stages.length };
}

export const isDone = (p: Pipeline): boolean => currentIndex(p) < 0;

export type GateText = { key: "none" | "check" | "approval"; command?: string };

export function gateText(gate: GateKind): GateText {
  if (gate.kind === "check") return { key: "check", command: joinCommand(gate.command) };
  return { key: gate.kind === "approval" ? "approval" : "none" };
}

/** Words of a command line; single or double quotes keep spaces in one word. */
export function splitCommand(text: string): string[] {
  const words: string[] = [];
  let word = "";
  let quote: string | null = null;
  let started = false;
  for (const ch of text) {
    if (quote) {
      if (ch === quote) quote = null;
      else word += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started || word) words.push(word);
      word = "";
      started = false;
    } else {
      word += ch;
    }
  }
  if (started || word) words.push(word);
  return words;
}

export function joinCommand(command: string[]): string {
  return command.map((w) => (/[\s"']/.test(w) || w === "" ? `"${w}"` : w)).join(" ");
}

/** The usual three stages: implement, tests (a check, when there is a command) and review (a person's approval). */
export function presetStages(check: string, names: { implement: string; tests: string; review: string; question: string }): StageSpec[] {
  const command = splitCommand(check);
  return [
    { name: names.implement, gate: { kind: "none" } },
    { name: names.tests, gate: command.length > 0 ? { kind: "check", command } : { kind: "none" } },
    { name: names.review, gate: { kind: "approval", question: names.question } },
  ];
}

export const STATUS_KEYS: Record<StageStatus, string> = {
  pending: "pipeline.status.pending",
  running: "pipeline.status.running",
  waiting: "pipeline.status.waiting",
  failed: "pipeline.status.failed",
  passed: "pipeline.status.passed",
};
