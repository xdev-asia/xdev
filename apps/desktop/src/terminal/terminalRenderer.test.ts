import { expect, it, vi } from "vitest";
import type { Terminal as XTerm } from "@xterm/xterm";
import { attachRenderer, type WebglLoader } from "./terminalRenderer";

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

/** A fake loader: every addon it makes is kept, so a test can lose its context. */
function fakes(opts: { fail?: boolean; construct?: boolean } = {}) {
  const addons: { loss: () => void; dispose: ReturnType<typeof vi.fn> }[] = [];
  const load = vi.fn<WebglLoader>(async () => {
    if (opts.fail) throw new Error("no webgl");
    return {
      WebglAddon: class {
        loss: () => void = () => {};
        dispose = vi.fn();
        constructor() {
          if (opts.construct) throw new Error("no context");
          addons.push(this);
        }
        onContextLoss(cb: () => void) {
          this.loss = cb;
          return { dispose() {} };
        }
      },
    };
  });
  const loaded: unknown[] = [];
  const term = { loadAddon: vi.fn((a: unknown) => void loaded.push(a)) } as unknown as XTerm;
  return { addons, load, term, loaded };
}

it("auto loads the addon once and reports webgl", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "auto", f.load);
  expect(r.active()).toBe("dom");
  await flush();
  expect(f.load).toHaveBeenCalledTimes(1);
  expect(f.addons).toHaveLength(1);
  expect(f.loaded).toHaveLength(1);
  expect(r.active()).toBe("webgl");
});

it("a load error leaves the pane on dom", async () => {
  const f = fakes({ fail: true });
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  expect(r.active()).toBe("dom");
  expect(f.loaded).toHaveLength(0);
});

it("an addon that cannot make its context leaves the pane on dom", async () => {
  const f = fakes({ construct: true });
  const r = attachRenderer(f.term, "on", f.load);
  await flush();
  expect(r.active()).toBe("dom");
});

it("a failing loadAddon leaves the pane on dom and disposes the addon", async () => {
  const f = fakes();
  (f.term.loadAddon as ReturnType<typeof vi.fn>).mockImplementation(() => {
    throw new Error("activate failed");
  });
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  expect(r.active()).toBe("dom");
  expect(f.addons[0].dispose).toHaveBeenCalled();
});

it("auto: a context loss disposes the addon and stays on dom", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  f.addons[0].loss();
  await flush();
  expect(r.active()).toBe("dom");
  expect(f.addons[0].dispose).toHaveBeenCalled();
  expect(f.load).toHaveBeenCalledTimes(1);
});

it("on: one context loss loads again, the second ends on dom", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "on", f.load);
  await flush();
  f.addons[0].loss();
  await flush();
  expect(f.addons).toHaveLength(2);
  expect(f.addons[0].dispose).toHaveBeenCalled();
  expect(r.active()).toBe("webgl");
  f.addons[1].loss();
  await flush();
  expect(f.addons).toHaveLength(2);
  expect(f.addons[1].dispose).toHaveBeenCalled();
  expect(r.active()).toBe("dom");
});

it("off never loads", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "off", f.load);
  await flush();
  expect(f.load).not.toHaveBeenCalled();
  expect(r.active()).toBe("dom");
});

it("set switches live: off disposes, auto loads again", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  r.set("off");
  expect(f.addons[0].dispose).toHaveBeenCalled();
  expect(r.active()).toBe("dom");
  r.set("auto");
  await flush();
  expect(f.addons).toHaveLength(2);
  expect(r.active()).toBe("webgl");
});

it("set to the same value does nothing; a change after a failure tries again", async () => {
  const f = fakes({ fail: true });
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  r.set("auto");
  await flush();
  expect(f.load).toHaveBeenCalledTimes(1);
  r.set("on");
  await flush();
  expect(f.load).toHaveBeenCalledTimes(2);
});

it("set to off while a load is pending drops the addon when it arrives", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "auto", f.load);
  r.set("off");
  await flush();
  expect(f.loaded).toHaveLength(0);
  expect(r.active()).toBe("dom");
});

it("dispose disposes the addon and ignores a load still pending", async () => {
  const f = fakes();
  const r = attachRenderer(f.term, "auto", f.load);
  await flush();
  r.dispose();
  expect(f.addons[0].dispose).toHaveBeenCalled();
  expect(r.active()).toBe("dom");

  const g = fakes();
  const late = attachRenderer(g.term, "auto", g.load);
  late.dispose();
  await flush();
  expect(g.loaded).toHaveLength(0);
  late.set("auto");
  await flush();
  expect(g.loaded).toHaveLength(0);
});
