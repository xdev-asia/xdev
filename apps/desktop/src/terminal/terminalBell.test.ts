import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBell, type AudioLike } from "./terminalBell";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fakePane() {
  const classes = new Set<string>();
  const listeners: Record<string, () => void> = {};
  return {
    classes,
    listeners,
    pane: {
      classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
      addEventListener: (name: string, cb: () => void) => void (listeners[name] = cb),
      removeEventListener: (name: string) => void delete listeners[name],
    } as unknown as HTMLElement,
  };
}

function fakeAudio(state = "running") {
  const tones: { type: string; started: boolean; stopped: boolean; gain: number }[] = [];
  const audio = {
    state,
    currentTime: 0,
    destination: {},
    resume: vi.fn(async () => {
      audio.state = "running";
    }),
    close: vi.fn(async () => {}),
    createOscillator() {
      const tone = { type: "square", started: false, stopped: false, gain: 0 };
      tones.push(tone);
      return {
        set type(v: string) {
          tone.type = v;
        },
        frequency: { value: 0 },
        connect() {},
        start: () => void (tone.started = true),
        stop: () => void (tone.stopped = true),
      };
    },
    createGain() {
      // The gain is written once, right after the oscillator was made: it belongs to that tone.
      const gain = {
        set value(v: number) {
          tones.at(-1)!.gain = v;
        },
      };
      return { gain, connect() {} };
    },
  };
  return { audio: audio as unknown as AudioLike, raw: audio, tones };
}

it("visual adds the class for 150 ms and removes it", () => {
  const { pane, classes } = fakePane();
  const bell = createBell(pane, { now: () => Date.now() });
  bell.ring("visual");
  expect(classes.has("terminal-bell")).toBe(true);
  vi.advanceTimersByTime(149);
  expect(classes.has("terminal-bell")).toBe(true);
  vi.advanceTimersByTime(2);
  expect(classes.has("terminal-bell")).toBe(false);
});

it("at most one cue per 250 ms", () => {
  const { pane, classes } = fakePane();
  const { audio, tones } = fakeAudio();
  const bell = createBell(pane, { now: () => Date.now(), audio: () => audio });
  bell.ring("visual");
  vi.advanceTimersByTime(160);
  bell.ring("visual");
  expect(classes.has("terminal-bell")).toBe(false);
  vi.advanceTimersByTime(100);
  bell.ring("visual");
  expect(classes.has("terminal-bell")).toBe(true);
  vi.advanceTimersByTime(300);
  bell.ring("sound");
  bell.ring("sound");
  expect(tones).toHaveLength(1);
});

it("sound starts one 100 ms sine tone at a low gain", () => {
  const { pane } = fakePane();
  const { audio, tones } = fakeAudio();
  const bell = createBell(pane, { now: () => Date.now(), audio: () => audio });
  bell.ring("sound");
  expect(tones).toHaveLength(1);
  expect(tones[0]).toMatchObject({ type: "sine", started: true, stopped: true });
  expect(tones[0].gain).toBeGreaterThan(0);
  expect(tones[0].gain).toBeLessThanOrEqual(0.2);
});

it("none does nothing, not even a throttle slot", () => {
  const { pane, classes } = fakePane();
  const { audio, tones } = fakeAudio();
  const audioFn = vi.fn(() => audio);
  const bell = createBell(pane, { now: () => Date.now(), audio: audioFn });
  bell.ring("none");
  bell.ring("visual");
  expect(classes.has("terminal-bell")).toBe(true);
  expect(tones).toHaveLength(0);
  expect(audioFn).not.toHaveBeenCalled();
});

it("the audio context is made lazily and resumed on the first keydown", async () => {
  const { pane, listeners } = fakePane();
  const { audio, raw } = fakeAudio("suspended");
  const audioFn = vi.fn(() => audio);
  const bell = createBell(pane, { now: () => Date.now(), audio: audioFn });
  expect(audioFn).not.toHaveBeenCalled();
  listeners.keydown();
  expect(audioFn).toHaveBeenCalledTimes(1);
  expect(raw.resume).toHaveBeenCalledTimes(1);
  listeners.keydown();
  expect(raw.resume).toHaveBeenCalledTimes(1);
  bell.ring("sound");
  expect(audioFn).toHaveBeenCalledTimes(1);
});

it("no audio available: sound is silent and does not throw", () => {
  const { pane } = fakePane();
  const bell = createBell(pane, { now: () => Date.now(), audio: () => null });
  expect(() => bell.ring("sound")).not.toThrow();
});

it("dispose removes the class, the timer and the keydown listener", () => {
  const { pane, classes, listeners } = fakePane();
  const { audio, raw } = fakeAudio();
  const bell = createBell(pane, { now: () => Date.now(), audio: () => audio });
  bell.ring("visual");
  listeners.keydown?.();
  bell.dispose();
  expect(classes.has("terminal-bell")).toBe(false);
  expect(listeners.keydown).toBeUndefined();
  expect(raw.close).toHaveBeenCalled();
  bell.ring("visual");
  expect(classes.has("terminal-bell")).toBe(false);
});
