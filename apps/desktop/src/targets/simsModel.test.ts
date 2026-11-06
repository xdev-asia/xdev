import { expect, it } from "vitest";
import type { SimDevice, SimList } from "@/api";
import { logTabTitle, simGroups, simLabel, simsEmpty } from "./simsModel";

const t = (key: string, vars?: Record<string, string | number>) =>
  ({ "targets.sim.booted": "Running", "targets.sim.shutdown": "Not running", "targets.sim.unknown": "Unknown state", "targets.sim.logTab": `Logs: ${vars?.name}` })[key] ?? key;

const phone = (over: Partial<SimDevice> = {}): SimDevice => ({
  platform: "ios",
  id: "u1",
  name: "iPhone 16",
  runtime: "iOS 18.0",
  state: "booted",
  serial: null,
  ...over,
});

it("labels a device with name, runtime and state", () => {
  expect(simLabel(phone(), t)).toBe("iPhone 16 · iOS 18.0 · Running");
  expect(simLabel(phone({ runtime: null, state: "shutdown", name: "Pixel_8_API_35" }), t)).toBe("Pixel_8_API_35 · Not running");
});

it("groups iOS and Android, and a running row streams logs while a stopped one boots", () => {
  const list: SimList = {
    ios: [phone(), phone({ id: "u2", name: "iPhone 15", state: "shutdown" })],
    android: [phone({ platform: "android", id: "Pixel_8_API_35", name: "Pixel_8_API_35", runtime: null, state: "unknown" })],
    problems: [],
  };
  const groups = simGroups(list, t);
  expect(groups.map((g) => g.key)).toEqual(["ios", "android"]);
  expect(groups[0]?.rows.map((r) => r.action)).toEqual(["logs", "boot"]);
  expect(groups[1]?.rows[0]?.running).toBe(false);
});

it("drops a group whose tool is missing and knows when nothing is left", () => {
  const list: SimList = { ios: null, android: [], problems: ["targets.sim.noXcode"] };
  expect(simGroups(list, t)).toEqual([]);
  expect(simsEmpty(list)).toBe(true);
  expect(simsEmpty({ ios: [phone()], android: null, problems: [] })).toBe(false);
});

it("titles the log tab with the device name", () => {
  expect(logTabTitle(phone({ name: "iPhone 15" }), t)).toBe("Logs: iPhone 15");
});
