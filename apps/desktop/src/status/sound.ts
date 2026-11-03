import type { Api, StatusSettings } from "@/api";

// At most one sound per this many ms, however many tabs change at once.
export const SOUND_GAP_MS = 2000;

let last = -Infinity;
let ctx: AudioContext | null = null;

function context(): AudioContext | null {
  if (ctx) return ctx;
  const Ctor = (globalThis as { AudioContext?: typeof AudioContext }).AudioContext;
  ctx = Ctor ? new Ctor() : null;
  return ctx;
}

/** A 180 ms two-tone beep at `volume` (0..100). */
export function playBeep(volume: number): void {
  const audio = context();
  if (!audio) return;
  const gain = audio.createGain();
  gain.gain.value = Math.max(0, Math.min(100, volume)) / 100 * 0.3;
  gain.connect(audio.destination);
  const t = audio.currentTime;
  for (const [freq, at] of [[880, 0], [1320, 0.09]] as const) {
    const osc = audio.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    osc.connect(gain);
    osc.start(t + at);
    osc.stop(t + at + 0.09);
  }
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
 * The status sound per the settings: the own file when one is set, else the beep.
 * `force` skips the switch and the 2 s gap (the settings page's test button).
 */
export async function playStatusSound(
  api: Pick<Api, "statusSound">,
  settings: StatusSettings,
  now: number = Date.now(),
  force = false,
): Promise<boolean> {
  if (!force && (!settings.sound || now - last < SOUND_GAP_MS)) return false;
  last = now;
  const bytes = settings.soundFile ? await api.statusSound().catch(() => null) : null;
  if (bytes) await playFile(bytes, settings.volume);
  else playBeep(settings.volume);
  return true;
}

/** Tests only. */
export function resetSoundGap(): void {
  last = -Infinity;
}
