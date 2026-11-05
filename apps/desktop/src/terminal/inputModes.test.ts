import { describe, expect, it } from "vitest";
import { trackInputModes } from "./inputModes";

type Id = { prefix?: string; intermediates?: string; final: string };
type Params = (number | number[])[];

// A parser that keeps the handlers registered on it, keyed by their identifier.
function fake() {
  const csi = new Map<string, (p: Params) => boolean>();
  const esc = new Map<string, () => boolean>();
  const key = (id: Id) => `${id.prefix ?? ""}${id.intermediates ?? ""}${id.final}`;
  const buffer = {
    active: { type: "normal" },
    listeners: [] as ((b: { type: string }) => void)[],
    onBufferChange(cb: (b: { type: string }) => void) {
      buffer.listeners.push(cb);
      return { dispose: () => void buffer.listeners.splice(buffer.listeners.indexOf(cb), 1) };
    },
    switchTo(type: string) {
      buffer.active = { type };
      buffer.listeners.forEach((cb) => cb(buffer.active));
    },
  };
  const term = {
    buffer,
    parser: {
      registerCsiHandler(id: Id, cb: (p: Params) => boolean) {
        csi.set(key(id), cb);
        return { dispose: () => void csi.delete(key(id)) };
      },
      registerEscHandler(id: Id, cb: () => boolean) {
        esc.set(key(id), cb);
        return { dispose: () => void esc.delete(key(id)) };
      },
    },
  };
  const run = (id: string, ...params: Params) => {
    const cb = csi.get(id);
    if (!cb) throw new Error(`no handler for ${id}`);
    return cb(params);
  };
  return { term, buffer, csi, esc, run };
}
const start = () => {
  const f = fake();
  const modes = trackInputModes(f.term as never);
  return { ...f, modes };
};

describe("trackInputModes", () => {
  it("starts at zero", () => {
    const { modes } = start();
    expect(modes.kittyFlags()).toBe(0);
    expect(modes.modifyOtherKeys()).toBe(0);
  });

  it("pushes and pops flags", () => {
    const { modes, run } = start();
    run(">u", 1);
    expect(modes.kittyFlags()).toBe(1);
    run(">u", 3);
    expect(modes.kittyFlags()).toBe(3);
    run("<u");
    expect(modes.kittyFlags()).toBe(1);
  });

  it("popping an empty stack leaves 0", () => {
    const { modes, run } = start();
    run(">u", 5);
    run("<u", 4);
    expect(modes.kittyFlags()).toBe(0);
    run("<u");
    expect(modes.kittyFlags()).toBe(0);
  });

  it("sets, ors and clears bits", () => {
    const { modes, run } = start();
    run("=u", 5, 1);
    expect(modes.kittyFlags()).toBe(5);
    run("=u", 2, 2);
    expect(modes.kittyFlags()).toBe(7);
    run("=u", 1, 3);
    expect(modes.kittyFlags()).toBe(6);
    run("=u", 8);
    expect(modes.kittyFlags()).toBe(8);
  });

  it("caps the stack at 16 entries", () => {
    const { modes, run } = start();
    for (let i = 1; i <= 20; i++) run(">u", i);
    expect(modes.kittyFlags()).toBe(20);
    for (let i = 0; i < 16; i++) run("<u");
    // The 4 oldest pushes fell off, so popping 16 lands on the oldest kept entry's predecessor.
    expect(modes.kittyFlags()).toBe(4);
  });

  it("keeps separate flags for the alternate screen", () => {
    const { modes, run, buffer } = start();
    run(">u", 1);
    buffer.active.type = "alternate";
    expect(modes.kittyFlags()).toBe(0);
    run(">u", 7);
    expect(modes.kittyFlags()).toBe(7);
    buffer.active.type = "normal";
    expect(modes.kittyFlags()).toBe(1);
  });

  it("tracks modifyOtherKeys only for resource 4", () => {
    const { modes, run } = start();
    run(">m", 4, 2);
    expect(modes.modifyOtherKeys()).toBe(2);
    run(">m", 4);
    expect(modes.modifyOtherKeys()).toBe(0);
    run(">m", 4, 1);
    run(">m", 1, 2);
    expect(modes.modifyOtherKeys()).toBe(1);
  });

  it("resets everything on DECSTR and on ESC c", () => {
    const { modes, run, esc, buffer } = start();
    const setAll = () => {
      run(">u", 3);
      buffer.active.type = "alternate";
      run(">u", 4);
      buffer.active.type = "normal";
      run(">m", 4, 2);
    };
    setAll();
    run("!p");
    expect([modes.kittyFlags(), modes.modifyOtherKeys()]).toEqual([0, 0]);
    buffer.active.type = "alternate";
    expect(modes.kittyFlags()).toBe(0);
    buffer.active.type = "normal";
    setAll();
    esc.get("c")!();
    expect([modes.kittyFlags(), modes.modifyOtherKeys()]).toEqual([0, 0]);
  });

  it("returns false from every handler so xterm still runs its own", () => {
    const { run, esc, csi } = start();
    expect([run(">u", 1), run("<u"), run("=u", 1), run(">m", 4, 1), run("!p")]).toEqual([
      false,
      false,
      false,
      false,
      false,
    ]);
    expect(esc.get("c")!()).toBe(false);
    // The query `CSI ? u` is not answered: nothing is registered for it.
    expect(csi.has("?u")).toBe(false);
  });

  it("removes its handlers on dispose", () => {
    const { modes, csi, esc } = start();
    modes.dispose();
    expect(csi.size).toBe(0);
    expect(esc.size).toBe(0);
  });
});

describe("stale modes", () => {
  it("entering the alternate screen again starts from zero flags", () => {
    const { buffer, run, modes } = start();
    buffer.switchTo("alternate");
    run(">u", 5);
    expect(modes.kittyFlags()).toBe(5);
    // The program was killed without popping its flags; the next full-screen program must not inherit them.
    buffer.switchTo("normal");
    buffer.switchTo("alternate");
    expect(modes.kittyFlags()).toBe(0);
  });

  it("the normal screen keeps its flags across an alternate screen visit", () => {
    const { buffer, run, modes } = start();
    run(">u", 3);
    buffer.switchTo("alternate");
    buffer.switchTo("normal");
    expect(modes.kittyFlags()).toBe(3);
  });

  it("reset() forgets kitty flags and modifyOtherKeys", () => {
    const { run, modes } = start();
    run(">u", 3);
    run(">m", 4, 2);
    modes.reset();
    expect(modes.kittyFlags()).toBe(0);
    expect(modes.modifyOtherKeys()).toBe(0);
  });

  it("dispose releases the buffer listener", () => {
    const { buffer, modes } = start();
    modes.dispose();
    expect(buffer.listeners).toHaveLength(0);
  });
});
