import { expect, it, vi } from "vitest";
import { createDictation, HOLD_MIN_MS, isReleaseOf, type DictationDeps, type Trigger } from "./controller";

type Mode = "toggle" | "hold";

function setup(opts: { mode?: Mode; start?: () => Promise<{ fallback: boolean }>; stop?: () => Promise<{ text: string }> } = {}) {
  let clock = 0;
  const api = {
    speechStart: vi.fn(opts.start ?? (async () => ({ fallback: false }))),
    speechStop: vi.fn(opts.stop ?? (async () => ({ text: "hi" }))),
    speechCancel: vi.fn(async () => {}),
  };
  const deps: DictationDeps<string> = {
    api,
    now: () => clock,
    mode: () => opts.mode ?? "toggle",
    target: () => "pane",
    insert: vi.fn(async () => "inserted" as const),
    toast: vi.fn(),
  };
  const ctl = createDictation(deps);
  return { ctl, api, deps, at: (ms: number) => (clock = ms) };
}

const E: Trigger = { code: "KeyE", meta: true, ctrl: false, alt: false, shift: false };

it("toggle: press starts once, press again stops and inserts the text", async () => {
  const { ctl, api, deps } = setup();
  await ctl.press();
  expect(api.speechStart).toHaveBeenCalledTimes(1);
  expect(ctl.state().phase).toBe("recording");
  await ctl.press();
  expect(api.speechStop).toHaveBeenCalledTimes(1);
  expect(deps.insert).toHaveBeenCalledWith("pane", "hi");
  expect(ctl.state().phase).toBe("idle");
});

it("hold: a release under the minimum cancels with a hint and uploads nothing", async () => {
  const { ctl, api, deps, at } = setup({ mode: "hold" });
  await ctl.press();
  at(HOLD_MIN_MS - 100);
  await ctl.release();
  expect(api.speechCancel).toHaveBeenCalledTimes(1);
  expect(api.speechStop).not.toHaveBeenCalled();
  expect(deps.toast).toHaveBeenCalledWith({ key: "dictation.holdHint" });
  expect(ctl.state().phase).toBe("idle");
});

it("hold: a long hold stops and transcribes on release", async () => {
  const { ctl, api, at } = setup({ mode: "hold" });
  await ctl.press();
  at(1000);
  await ctl.release();
  expect(api.speechStop).toHaveBeenCalledTimes(1);
  expect(api.speechCancel).not.toHaveBeenCalled();
});

it("hold: a second press while held does nothing", async () => {
  const { ctl, api } = setup({ mode: "hold" });
  await ctl.press();
  await ctl.press();
  expect(api.speechStart).toHaveBeenCalledTimes(1);
  expect(api.speechStop).not.toHaveBeenCalled();
});

it("hold: losing the window focus stops and transcribes", async () => {
  const { ctl, api } = setup({ mode: "hold" });
  await ctl.press();
  await ctl.blur();
  expect(api.speechStop).toHaveBeenCalledTimes(1);
});

it("toggle: losing the window focus keeps recording", async () => {
  const { ctl, api } = setup();
  await ctl.press();
  await ctl.blur();
  expect(api.speechStop).not.toHaveBeenCalled();
  expect(ctl.state().phase).toBe("recording");
});

it("escape cancels a recording and is swallowed; while idle it is left alone", async () => {
  const { ctl, api } = setup();
  expect(await ctl.escape()).toBe(false);
  expect(api.speechCancel).not.toHaveBeenCalled();
  await ctl.press();
  expect(await ctl.escape()).toBe(true);
  expect(api.speechCancel).toHaveBeenCalledTimes(1);
  expect(ctl.state().phase).toBe("idle");
});

it("escape while starting cancels the session once it has started", async () => {
  let resolve!: (v: { fallback: boolean }) => void;
  const { ctl, api } = setup({ start: () => new Promise((r) => (resolve = r)) });
  const pressed = ctl.press();
  expect(ctl.state().phase).toBe("starting");
  expect(await ctl.escape()).toBe(true);
  resolve({ fallback: false });
  await pressed;
  expect(api.speechCancel).toHaveBeenCalled();
  expect(ctl.state().phase).toBe("idle");
});

it("the length cap stops once", async () => {
  const { ctl, api } = setup();
  await ctl.press();
  await ctl.level({ elapsedMs: 120_000, level: 10, capped: true });
  await ctl.level({ elapsedMs: 120_000, level: 10, capped: true });
  expect(api.speechStop).toHaveBeenCalledTimes(1);
});

it("level events update the elapsed time while recording", async () => {
  const { ctl } = setup();
  await ctl.level({ elapsedMs: 500, level: 1, capped: false });
  expect(ctl.state().elapsedMs).toBe(0);
  await ctl.press();
  await ctl.level({ elapsedMs: 7400, level: 1, capped: false });
  expect(ctl.state().elapsedMs).toBe(7400);
});

it("a denied microphone shows its error with the privacy action", async () => {
  const { ctl, deps } = setup({ start: () => Promise.reject({ code: "speech_mic_denied" }) });
  await ctl.press();
  expect(ctl.state().phase).toBe("idle");
  expect(deps.toast).toHaveBeenCalledWith({ key: "error.speech_mic_denied", detail: undefined, action: "openPrivacy" });
});

it("no key shows its error with the connect action", async () => {
  const { ctl, deps } = setup({ start: () => Promise.reject({ code: "speech_no_key" }) });
  await ctl.press();
  expect(deps.toast).toHaveBeenCalledWith({ key: "error.speech_no_key", detail: undefined, action: "connect" });
});

it("an engine error carries its detail; an unknown rejection becomes io", async () => {
  const { ctl, deps } = setup({ stop: () => Promise.reject({ code: "speech_engine", detail: "500" }) });
  await ctl.press();
  await ctl.press();
  expect(deps.toast).toHaveBeenCalledWith({ key: "error.speech_engine", detail: "500", action: undefined });
  expect(ctl.state().phase).toBe("idle");

  const other = setup({ start: () => Promise.reject(new Error("boom")) });
  await other.ctl.press();
  expect(other.deps.toast).toHaveBeenCalledWith({ key: "error.io", detail: undefined, action: undefined });
});

it("press while transcribing is ignored", async () => {
  let resolve!: (v: { text: string }) => void;
  const { ctl, api } = setup({ stop: () => new Promise((r) => (resolve = r)) });
  await ctl.press();
  const stopping = ctl.press();
  expect(ctl.state().phase).toBe("transcribing");
  await ctl.press();
  expect(api.speechStart).toHaveBeenCalledTimes(1);
  expect(api.speechStop).toHaveBeenCalledTimes(1);
  resolve({ text: "x" });
  await stopping;
  expect(ctl.state().phase).toBe("idle");
});

it("the fallback microphone and a clipboard insert each toast", async () => {
  const { ctl, deps } = setup({ start: async () => ({ fallback: true }) });
  vi.mocked(deps.insert).mockResolvedValueOnce("copied");
  await ctl.press();
  expect(deps.toast).toHaveBeenCalledWith({ key: "dictation.fallbackMic" });
  await ctl.press();
  expect(deps.toast).toHaveBeenCalledWith({ key: "dictation.copied" });
});

it("subscribers hear every phase change", async () => {
  const { ctl } = setup();
  const seen: string[] = [];
  const off = ctl.subscribe(() => seen.push(ctl.state().phase));
  await ctl.press();
  await ctl.press();
  off();
  expect(seen).toEqual(["starting", "recording", "transcribing", "idle"]);
});

it("isReleaseOf matches the trigger key or any modifier of the chord", () => {
  expect(isReleaseOf(E, { code: "MetaLeft" })).toBe(true);
  expect(isReleaseOf(E, { code: "KeyE" })).toBe(true);
  expect(isReleaseOf(E, { code: "KeyA" })).toBe(false);
  expect(isReleaseOf(E, { code: "ControlLeft" })).toBe(false);
  const space: Trigger = { code: "Space", meta: false, ctrl: true, alt: false, shift: true };
  expect(isReleaseOf(space, { code: "ShiftRight" })).toBe(true);
  expect(isReleaseOf(space, { code: "ControlRight" })).toBe(true);
  expect(isReleaseOf(space, { code: "AltLeft" })).toBe(false);
});
