import type { Api, SoundName, StatusSettings } from "@/api";

// At most one sound per this many ms, however many tabs change at once.
export const SOUND_GAP_MS = 2000;

/** The built-in sounds, in the order the picker lists them. All are synthesised; no file is shipped. */
export const SOUND_NAMES = ["two-tone", "chime", "ding", "blip", "pop", "knock"] as const;
export type BuiltInSound = Exclude<SoundName, "file">;

interface ParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  exponentialRampToValueAtTime(value: number, time: number): unknown;
}

/** The parts of a WebAudio context the built-in sounds use. */
export interface AudioLike {
  readonly currentTime: number;
  readonly destination: unknown;
  createGain(): { gain: ParamLike; connect(to: unknown): unknown };
  createOscillator(): {
    type: OscillatorType;
    frequency: ParamLike;
    connect(to: unknown): unknown;
    start(time: number): void;
    stop(time: number): void;
  };
  resume?(): Promise<void> | void;
}

interface Note {
  /** Start, seconds from now. */
  at: number;
  /** Length, seconds. */
  len: number;
  freq: number;
  /** Glide to this frequency over the note. */
  to?: number;
  type: OscillatorType;
  /** Relative loudness, 0..1. */
  level: number;
}

// Each is 120–450 ms from the first start to the last stop.
const SOUNDS: Record<BuiltInSound, readonly Note[]> = {
  "two-tone": [
    { at: 0, len: 0.09, freq: 880, type: "sine", level: 1 },
    { at: 0.09, len: 0.09, freq: 1320, type: "sine", level: 1 },
  ],
  chime: [
    { at: 0, len: 0.25, freq: 784, type: "sine", level: 0.9 },
    { at: 0.1, len: 0.25, freq: 1175, type: "sine", level: 0.8 },
    { at: 0.2, len: 0.25, freq: 1568, type: "sine", level: 0.7 },
  ],
  ding: [{ at: 0, len: 0.4, freq: 1568, type: "sine", level: 1 }],
  blip: [{ at: 0, len: 0.13, freq: 660, to: 990, type: "square", level: 0.5 }],
  pop: [{ at: 0, len: 0.14, freq: 520, to: 140, type: "sine", level: 1 }],
  knock: [
    { at: 0, len: 0.08, freq: 190, to: 110, type: "triangle", level: 1 },
    { at: 0.14, len: 0.08, freq: 190, to: 110, type: "triangle", level: 1 },
  ],
};

let last = -Infinity;
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  ctx = Ctor ? new Ctor() : null;
  return ctx;
}

/** A built-in sound at `volume` (0..100). Silent when there is no WebAudio. */
export function playBuiltIn(name: BuiltInSound, volume: number, audio: AudioLike | null = context()): void {
  if (!audio) return;
  try {
    // Some webviews start the context suspended until a gesture; best effort.
    void Promise.resolve(audio.resume?.()).catch(() => {});
    const master = (Math.max(0, Math.min(100, volume)) / 100) * 0.3;
    const t = audio.currentTime;
    for (const note of SOUNDS[name] ?? SOUNDS["two-tone"]) {
      const start = t + note.at;
      const end = start + note.len;
      const gain = audio.createGain();
      gain.gain.setValueAtTime(Math.max(0.0001, master * note.level), start);
      // Fade out, so the end of a note does not click.
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      gain.connect(audio.destination);
      const osc = audio.createOscillator();
      osc.type = note.type;
      osc.frequency.setValueAtTime(note.freq, start);
      if (note.to) osc.frequency.exponentialRampToValueAtTime(note.to, end);
      osc.connect(gain);
      osc.start(start);
      osc.stop(end);
    }
  } catch {
    // No sound is better than an error in the notifier.
  }
}

/** The two-tone beep at `volume` (0..100). */
export function playBeep(volume: number): void {
  playBuiltIn("two-tone", volume);
}

/** Plays the person's own file from its bytes; falls back to the beep when it cannot. */
export async function playFile(bytes: Uint8Array, volume: number): Promise<void> {
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  try {
    const el = new Audio(url);
    el.volume = Math.max(0, Math.min(100, volume)) / 100;
    await el.play();
    el.addEventListener("ended", () => URL.revokeObjectURL(url), { once: true });
  } catch {
    URL.revokeObjectURL(url);
    playBeep(volume);
  }
}

/**
 * The status sound per the settings: the own file when "file" is chosen and one is set, else the chosen
 * built-in sound (a missing file falls back to the two-tone beep).
 * `force` skips the switch and the 2 s gap (the settings page's play button).
 */
export async function playStatusSound(
  api: Pick<Api, "statusSound">,
  settings: StatusSettings,
  now: number = Date.now(),
  force = false,
): Promise<boolean> {
  if (!force && (!settings.sound || now - last < SOUND_GAP_MS)) return false;
  last = now;
  const bytes = settings.soundName === "file" && settings.soundFile ? await api.statusSound().catch(() => null) : null;
  if (bytes) await playFile(bytes, settings.volume);
  else playBuiltIn(settings.soundName === "file" ? "two-tone" : settings.soundName, settings.volume);
  return true;
}

/** Tests only. */
export function resetSoundGap(): void {
  last = -Infinity;
}
