import { beforeEach, expect, it, vi } from "vitest";
import { DEFAULT_STATUS } from "@/mockStatus";
import { playBuiltIn, playStatusSound, resetSoundGap, SOUND_GAP_MS, SOUND_NAMES, type AudioLike } from "./sound";

const api = { statusSound: async () => null };

beforeEach(resetSoundGap);

it("plays at most once per gap", async () => {
  expect(await playStatusSound(api, DEFAULT_STATUS, 1000)).toBe(true);
  expect(await playStatusSound(api, DEFAULT_STATUS, 1000 + SOUND_GAP_MS - 1)).toBe(false);
  expect(await playStatusSound(api, DEFAULT_STATUS, 1000 + SOUND_GAP_MS)).toBe(true);
});

it("stays quiet when the switch is off unless forced", async () => {
  const off = { ...DEFAULT_STATUS, sound: false };
  expect(await playStatusSound(api, off, 1)).toBe(false);
  expect(await playStatusSound(api, off, 2, true)).toBe(true);
});

const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });

function fakeAudio() {
  const spans: { start: number; stop: number }[] = [];
  const audio: AudioLike = {
    currentTime: 10,
    destination: {},
    createGain: () => ({ gain: param(), connect() {} }),
    createOscillator() {
      let start = 0;
      return {
        type: "sine",
        frequency: param(),
        connect() {},
        start(t) {
          start = t;
        },
        stop(t) {
          spans.push({ start, stop: t });
        },
      };
    },
  };
  return { audio, spans };
}

it("each built-in schedules oscillators within 0.5 s on a fake AudioContext", () => {
  for (const name of SOUND_NAMES) {
    const { audio, spans } = fakeAudio();
    playBuiltIn(name, 60, audio);
    expect(spans.length, name).toBeGreaterThan(0);
    const from = Math.min(...spans.map((s) => s.start));
    const to = Math.max(...spans.map((s) => s.stop));
    expect(from, name).toBeGreaterThanOrEqual(10);
    expect(to - 10, name).toBeLessThanOrEqual(0.5);
    expect(to - from, name).toBeGreaterThanOrEqual(0.12);
  }
});

it("file name with no file falls back to two-tone", async () => {
  const freqs: number[] = [];
  class FakeContext {
    currentTime = 0;
    destination = {};
    createGain() {
      return { gain: param(), connect() {} };
    }
    createOscillator() {
      return {
        type: "sine",
        frequency: { value: 0, setValueAtTime: (v: number) => void freqs.push(v), exponentialRampToValueAtTime() {} },
        connect() {},
        start() {},
        stop() {},
      };
    }
  }
  vi.stubGlobal("AudioContext", FakeContext);
  try {
    expect(await playStatusSound(api, { ...DEFAULT_STATUS, soundName: "file", soundFile: null }, 1, true)).toBe(true);
    // The two-tone notes are 880 Hz, then 1320 Hz.
    expect(freqs).toEqual([880, 1320]);
  } finally {
    vi.unstubAllGlobals();
  }
});
