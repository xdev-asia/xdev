import { beforeEach, expect, it } from "vitest";
import { DEFAULT_STATUS } from "@/mockStatus";
import { playStatusSound, resetSoundGap, SOUND_GAP_MS } from "./sound";

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
