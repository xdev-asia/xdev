import type { TerminalBell } from "@/api";

/** The part of `AudioContext` the bell uses; a test passes a fake. */
export interface AudioLike {
  readonly state: string;
  readonly currentTime: number;
  readonly destination: unknown;
  resume(): Promise<void>;
  close?(): Promise<void>;
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

/**
 * What a pane does on BEL: `visual` flashes `.terminal-bell` for 150 ms, `sound` plays a 100 ms sine
 * tone, `none` nothing. At most one cue per 250 ms. The audio context is made on first use and
 * resumed on the pane's first keydown, since a webview keeps audio suspended until a gesture.
 */
export function createBell(
  pane: HTMLElement,
  opts: { now?: () => number; audio?: () => AudioLike | null } = {},
): { ring(mode: TerminalBell): void; dispose(): void } {
  const now = opts.now ?? (() => performance.now());
  const makeAudio = opts.audio ?? browserAudio;
  let ctx: AudioLike | null = null;
  let tried = false;
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const context = (): AudioLike | null => {
    if (!tried) {
      tried = true;
      ctx = makeAudio();
    }
    return ctx;
  };

  let resumed = false;
  const onKeydown = () => {
    if (resumed) return;
    resumed = true;
    void context()?.resume().catch(() => {});
  };
  pane.addEventListener("keydown", onKeydown, true);

  const flash = () => {
    clearTimeout(timer);
    pane.classList.add("terminal-bell");
    timer = setTimeout(() => pane.classList.remove("terminal-bell"), FLASH_MS);
  };

  const beep = () => {
    const audio = context();
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
      void ctx?.close?.().catch(() => {});
    },
  };
}
