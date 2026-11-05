import { expect, test } from "vitest";
import { createMockSettings } from "./mockSettings";
import { createMockPower, wantsAwake } from "./mockPower";

function setup() {
  const settings = createMockSettings();
  return { settings, power: createMockPower(settings) };
}

test("wantsAwake follows the mode and the working flag", () => {
  expect([true, false].map((w) => wantsAwake("on", w))).toEqual([true, true]);
  expect([true, false].map((w) => wantsAwake("agent", w))).toEqual([true, false]);
  expect([true, false].map((w) => wantsAwake("off", w))).toEqual([false, false]);
});

test("the default mode is off and nothing is held", async () => {
  const { power } = setup();
  expect(await power.keepAwake()).toEqual({ mode: "off", held: false, supported: true });
});

test("a mode set is stored in the agents settings and reported", async () => {
  const { power, settings } = setup();
  const seen: unknown[] = [];
  await power.onKeepAwakeChanged((v) => seen.push(v));
  expect(await power.keepAwakeSet("on")).toEqual({ mode: "on", held: true, supported: true });
  expect((await settings.agentsSettings()).keepAwake).toBe("on");
  expect(seen).toEqual([{ mode: "on", held: true, supported: true }]);
});

test("agent mode holds only while agents work, and reports edges only", async () => {
  const { power } = setup();
  const seen: unknown[] = [];
  const stop = await power.onKeepAwakeChanged((v) => seen.push(v));
  await power.keepAwakeSet("agent");
  expect((await power.keepAwakeAgents(true)).held).toBe(true);
  await power.keepAwakeAgents(true);
  expect((await power.keepAwakeAgents(false)).held).toBe(false);
  expect(seen).toHaveLength(3);
  stop();
  await power.keepAwakeSet("off");
  expect(seen).toHaveLength(3);
});

test("saving the agents settings with another keep-awake mode reports it", async () => {
  const { power, settings } = setup();
  const seen: unknown[] = [];
  await power.onKeepAwakeChanged((v) => seen.push(v));
  const base = await settings.agentsSettings();
  await power.agentsSettingsPut({ ...base, keepAwake: "on" });
  expect(seen).toEqual([{ mode: "on", held: true, supported: true }]);
  // The same mode again says nothing.
  await power.agentsSettingsPut({ ...base, keepAwake: "on" });
  expect(seen).toHaveLength(1);
  expect(await power.keepAwake()).toEqual({ mode: "on", held: true, supported: true });
});
