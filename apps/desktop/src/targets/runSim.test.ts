import { expect, it, vi } from "vitest";
import type { SimDevice, SimLaunch } from "@/api";
import type { Sessions } from "@/workspace/sessions";
import { runSim } from "./runSim";

const t = (key: string, vars?: Record<string, string | number>) => (key === "targets.sim.logTab" ? `Logs: ${vars?.name}` : key);

function harness(launch: SimLaunch | Error) {
  const opened: { title?: string; typed: string[] }[] = [];
  const sessions = {
    open: vi.fn((_wt: string, _p: string, _a: unknown, _c: unknown, opts: { title?: string }) => {
      const rec = { title: opts.title, typed: [] as string[] };
      opened.push(rec);
      return { client: { typeWhenReady: (s: string) => rec.typed.push(s) } };
    }),
  } as unknown as Sessions;
  const api = { simBoot: vi.fn(() => (launch instanceof Error ? Promise.reject({ code: "sim_not_found" }) : Promise.resolve(launch))) };
  return { opened, sessions, api };
}

const device = (over: Partial<SimDevice>): SimDevice => ({
  platform: "ios",
  id: "u2",
  name: "iPhone 15",
  runtime: "iOS 17.5",
  state: "shutdown",
  serial: null,
  ...over,
});

it("iOS opens one log tab", async () => {
  const h = harness({ tabCommand: null, logCommand: "xcrun simctl spawn u2 log stream", title: "iPhone 15" });
  const res = await runSim(device({}), { api: h.api, sessions: h.sessions, worktree: "/w", t });
  expect(res.ok).toBe(true);
  expect(h.api.simBoot).toHaveBeenCalledWith({ platform: "ios", id: "u2" });
  expect(h.opened).toEqual([{ title: "Logs: iPhone 15", typed: ["xcrun simctl spawn u2 log stream\r"] }]);
});

it("Android opens an emulator tab, then a log tab", async () => {
  const h = harness({ tabCommand: "emulator -avd Pixel_8_API_35", logCommand: "adb wait-for-device && adb logcat -v color", title: "x" });
  const res = await runSim(device({ platform: "android", id: "Pixel_8_API_35", name: "Pixel_8_API_35" }), {
    api: h.api,
    sessions: h.sessions,
    worktree: "/w",
    t,
  });
  expect(res.ok && res.tabs.length).toBe(2);
  expect(h.opened).toEqual([
    { title: "Pixel_8_API_35", typed: ["emulator -avd Pixel_8_API_35\r"] },
    { title: "Logs: Pixel_8_API_35", typed: ["adb wait-for-device && adb logcat -v color\r"] },
  ]);
});

it("a failed boot opens nothing and gives the error code", async () => {
  const h = harness(new Error("x"));
  const res = await runSim(device({}), { api: h.api, sessions: h.sessions, worktree: "/w", t });
  expect(res).toEqual({ ok: false, code: "sim_not_found" });
  expect(h.opened).toEqual([]);
});
