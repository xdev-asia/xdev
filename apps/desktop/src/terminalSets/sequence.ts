import type { SequenceStep } from "@/api";
import { terminalBytes } from "@/quickCommands/run";

/** What a sequence needs from the world; fakes stand in for it in tests. */
export interface SequenceIo {
  /** Types bytes into the terminal; rejects when the write fails. */
  write(bytes: string): Promise<void>;
  sleep(ms: number): Promise<void>;
  /** Resolves when the terminal has gone quiet (true), or gave up waiting (false). */
  idle(): Promise<boolean>;
  /** True once the caller no longer wants the rest (the tab closed, say). */
  cancelled?(): boolean;
}

export type SequenceResult =
  | { status: "done"; ran: number }
  /** The write of step `at` failed; the steps after it did not run. */
  | { status: "failed"; ran: number; at: number }
  | { status: "cancelled"; ran: number };

/**
 * Types each command in order, with Enter. After a step, its wait runs before the next one starts:
 * "wait N s" sleeps, "wait for idle" waits for quiet, none goes on at once. The wait of the last step
 * is skipped. A failed write stops the sequence there.
 */
export async function runSequence(steps: readonly SequenceStep[], io: SequenceIo): Promise<SequenceResult> {
  let ran = 0;
  for (let i = 0; i < steps.length; i++) {
    if (io.cancelled?.()) return { status: "cancelled", ran };
    try {
      await io.write(terminalBytes(steps[i].command, true));
    } catch {
      return { status: "failed", ran, at: i };
    }
    ran++;
    if (i === steps.length - 1) break;
    const wait = steps[i].wait;
    if (wait.type === "seconds") await io.sleep(wait.seconds * 1000);
    else if (wait.type === "idle") await io.idle();
  }
  return io.cancelled?.() ? { status: "cancelled", ran } : { status: "done", ran };
}

/** A step that types `command` and goes on at once. */
export const plainStep = (command: string): SequenceStep => ({ command, wait: { type: "none" } });
