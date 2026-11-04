import type { TerminalBell } from "@/api";

/** The part of `AudioContext` the bell uses; a test passes a fake. */
export interface AudioLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  createOscillator(): {
    type: string;
    frequency: { value: number };
    connect(to: unknown): unknown;
    start(when?: number): void;
    stop(when?: number): void;
  };
  createGain(): { gain: { value: number }; connect(to: unknown): unknown };
}

const FLASH_MS = 150;
const TONE_MS = 100;
const TONE_HZ = 880;
const TONE_GAIN = 0.08;
const THROTTLE_MS = 250;

const browserAudio = (): AudioLike | null => {
  const Ctx = (globalThis as { AudioContext?: new () => AudioLike }).AudioContext;
  try {
    return Ctx ? new Ctx() : null;
  } catch {
    return null;
  }
};

// One audio context for every pane: a webview caps how many it allows, and each costs a thread.
// Made on the first need while the bell is `sound`, and kept for the app's life (a pane closing
// does not close it: other panes share it).
let shared: AudioLike | null = null;
let sharedTried = false;

function sharedAudio(make: () => AudioLike | null): AudioLike | null {
  if (!sharedTried) {
    sharedTried = true;
    shared = make();
  }
  return shared;
}

/** Tests only: forget the shared audio context so the next one is made afresh. */
export function resetBellAudioForTest(): void {
  shared = null;
  sharedTried = false;
}

/**
 * What a pane does on BEL: `visual` flashes `.terminal-bell` for 150 ms, `sound` plays a 100 ms sine
 * tone, `none` nothing. At most one cue per 250 ms per pane. The one shared audio context is made
 * only while the bell is `sound`: on a pane's keydown (a webview keeps audio suspended until a
 * gesture, so that keydown also resumes it) or on the first tone.
 */
export function createBell(
  pane: HTMLElement,
  opts: { now?: () => number; audio?: () => AudioLike | null; mode?: () => TerminalBell } = {},
): { ring(mode: TerminalBell): void; dispose(): void } {
  const now = opts.now ?? (() => performance.now());
  const makeAudio = opts.audio ?? browserAudio;
  const mode = opts.mode ?? (() => "visual" as TerminalBell);
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const onKeydown = () => {
    if (mode() !== "sound") return;
    const audio = sharedAudio(makeAudio);
    if (audio?.state === "suspended") void audio.resume().catch(() => {});
  };
  pane.addEventListener("keydown", onKeydown, true);

  const flash = () => {
    clearTimeout(timer);
    pane.classList.add("terminal-bell");
    timer = setTimeout(() => pane.classList.remove("terminal-bell"), FLASH_MS);
  };

  const beep = () => {
    const audio = sharedAudio(makeAudio);
    if (!audio) return;
    try {
      if (audio.state === "suspended") void audio.resume().catch(() => {});
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = "sine";
      osc.frequency.value = TONE_HZ;
      gain.gain.value = TONE_GAIN;
      osc.connect(gain);
      gain.connect(audio.destination);
      osc.start();
      osc.stop(audio.currentTime + TONE_MS / 1000);
    } catch {
      // No sound is better than a broken pane.
    }
  };

  return {
    ring(mode) {
      if (disposed || mode === "none") return;
      const t = now();
      if (t - last < THROTTLE_MS) return;
      last = t;
      if (mode === "visual") flash();
      else beep();
    },
    dispose() {
      disposed = true;
      clearTimeout(timer);
      pane.classList.remove("terminal-bell");
      pane.removeEventListener("keydown", onKeydown, true);
    },
  };
}
