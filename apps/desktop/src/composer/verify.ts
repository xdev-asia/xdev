// Verified send: type a prompt into a terminal tab, press Enter and watch the tab's output for a
// reply. No new output within CONFIRM_MS: Enter once more. Still none: "unconfirmed", no more retries.

import { pastePrompt } from "@/workspace/agentPrompt";

/** How long a sent prompt waits for new output after Enter. */
export const CONFIRM_MS = 2500;
/** The pause between typing the text and pressing Enter, so the echo of the text lands first. */
export const SETTLE_MS = 300;
/** How often the output is looked at while waiting. */
export const POLL_MS = 100;

export type SendResult = "sent" | "unconfirmed" | "failed";

/** Where a verified send stands: which Enter it waits on, the output seen when it was pressed, and when. */
export type Watch = { enter: 1 | 2; baseline: number | null; enterAt: number };

export type Decision = "sent" | "wait" | "retry" | "unconfirmed";

/**
 * The next move of a verified send. `last` is the time of the tab's latest output (null for none).
 * Output newer than the baseline is a reply; otherwise wait up to `confirmMs` after Enter, then
 * press Enter once more (`retry`) after the first and give up (`unconfirmed`) after the second.
 */
export function decide(watch: Watch, last: number | null, now: number, confirmMs = CONFIRM_MS): Decision {
  if (last !== null && (watch.baseline === null || last > watch.baseline)) return "sent";
  if (now - watch.enterAt < confirmMs) return "wait";
  return watch.enter === 1 ? "retry" : "unconfirmed";
}

/** The bytes that type `text` without pressing Enter: one pasted block for an agent, lines for a shell. */
export function typedBytes(text: string, agent: boolean): string {
  if (agent) return pastePrompt(text).slice(0, -1);
  return text.replace(/\r\n|\n/g, "\r").replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f]/g, "");
}

export interface SendDeps {
  write(data: string): Promise<void>;
  /** The time of the tab's latest output; null when it printed nothing yet. */
  lastOutput(): number | null;
  now(): number;
  sleep(ms: number): Promise<void>;
}

export type SendTiming = { confirmMs?: number; settleMs?: number; pollMs?: number };

/** Types `text`, presses Enter and watches for a reply as `decide` says. A failed write is "failed". */
export async function verifiedSend(text: string, agent: boolean, deps: SendDeps, timing: SendTiming = {}): Promise<SendResult> {
  const confirmMs = timing.confirmMs ?? CONFIRM_MS;
  const pollMs = timing.pollMs ?? POLL_MS;
  try {
    await deps.write(typedBytes(text, agent));
    await deps.sleep(timing.settleMs ?? SETTLE_MS);
    let watch: Watch = { enter: 1, baseline: deps.lastOutput(), enterAt: deps.now() };
    await deps.write("\r");
    for (;;) {
      await deps.sleep(pollMs);
      const next = decide(watch, deps.lastOutput(), deps.now(), confirmMs);
      if (next === "sent" || next === "unconfirmed") return next;
      if (next === "retry") {
        watch = { enter: 2, baseline: deps.lastOutput(), enterAt: deps.now() };
        await deps.write("\r");
      }
    }
  } catch {
    return "failed";
  }
}

/** The tabs to send to again: those not confirmed or failed. */
export function retryTargets(results: Readonly<Record<string, SendResult>>): string[] {
  return Object.entries(results)
    .filter(([, r]) => r !== "sent")
    .map(([id]) => id);
}
