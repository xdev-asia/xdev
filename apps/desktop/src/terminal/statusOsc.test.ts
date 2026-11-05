import { expect, it, vi } from "vitest";
import { installStatusOsc } from "./statusOsc";

function setup(replaying = false) {
  const handlers = new Map<number, (data: string) => boolean>();
  const parser = { registerOscHandler: (id: number, cb: (data: string) => boolean) => (handlers.set(id, cb), { dispose() {} }) };
  const deps = { reply: vi.fn(), replaying: () => replaying, onProgramStatus: vi.fn(), onProgress: vi.fn() };
  installStatusOsc(parser, deps);
  return { handlers, deps };
}

it("answers the probe unless replaying", () => {
  const live = setup();
  expect(live.handlers.get(7501)!("?")).toBe(true);
  expect(live.deps.reply).toHaveBeenCalledWith("\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\");
  const old = setup(true);
  expect(old.handlers.get(7501)!("?")).toBe(true);
  expect(old.deps.reply).not.toHaveBeenCalled();
});

it("passes a report on, and ignores a child record", () => {
  const { handlers, deps } = setup();
  expect(handlers.get(7501)!("state=working:progress=5")).toBe(true);
  expect(deps.onProgramStatus).toHaveBeenCalledWith(expect.objectContaining({ state: "working", progress: 5 }));
  deps.onProgramStatus.mockClear();
  expect(handlers.get(7501)!("state=done:id=a/b")).toBe(true);
  expect(handlers.get(7501)!("garbage")).toBe(true);
  expect(deps.onProgramStatus).not.toHaveBeenCalled();
});

it("reads OSC 9 progress and leaves other OSC 9 alone", () => {
  const { handlers, deps } = setup();
  expect(handlers.get(9)!("4;1;40")).toBe(true);
  expect(deps.onProgress).toHaveBeenCalledWith(40);
  deps.onProgress.mockClear();
  expect(handlers.get(9)!("hello there")).toBe(true);
  expect(deps.onProgress).not.toHaveBeenCalled();
});
