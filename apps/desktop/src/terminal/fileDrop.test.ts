import { describe, expect, it, vi } from "vitest";
import type { ShellKind } from "./pathPaste";
import { registerDropTarget, startFileDrop, type DropEvent } from "./fileDrop";

// A host element stand-in: a class list and `contains`.
function host(children: object[] = []) {
  const classes = new Set<string>();
  const self = {
    classes,
    classList: { add: (c: string) => void classes.add(c), remove: (c: string) => void classes.delete(c) },
    contains: (el: unknown) => el === self || children.includes(el as object),
  };
  return self;
}

function setup(over: { scale?: number } = {}) {
  let emit: (e: DropEvent) => void = () => {};
  const unlisten = vi.fn();
  const hit = vi.fn<(x: number, y: number) => Element | null>();
  const onError = vi.fn();
  const onRejected = vi.fn();
  const stop = startFileDrop({
    listen: async (cb) => {
      emit = cb;
      return unlisten;
    },
    scale: () => over.scale ?? 2,
    hit,
    onError,
    onRejected,
  });
  return { send: (e: DropEvent) => emit(e), unlisten, hit, onError, onRejected, stop };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

function pane(over: { ready?: boolean; shell?: ShellKind; bracketed?: boolean; write?: (d: string) => Promise<void> } = {}) {
  const el = {};
  const h = host([el]);
  const calls: string[] = [];
  const target = {
    write: vi.fn(over.write ?? (async (d: string) => void calls.push(`write:${d}`))),
    ready: () => over.ready ?? true,
    shell: () => over.shell ?? "posix",
    bracketed: () => over.bracketed ?? true,
    focus: vi.fn(() => void calls.push("focus")),
  };
  const off = registerDropTarget(h as never, target);
  return { el, h, target, calls, off };
}

describe("startFileDrop", () => {
  it("maps the physical drop position to CSS pixels and writes each path in order, then focuses", async () => {
    const s = setup({ scale: 2 });
    const p = pane();
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["/a/b.txt", "/my dir/c.txt"], position: { x: 200, y: 100 } });
    await flush();
    expect(s.hit).toHaveBeenCalledWith(100, 50);
    expect(p.calls).toEqual(["write:/a/b.txt ", "write:/my\\ dir/c.txt ", "focus"]);
    p.off();
    s.stop();
  });

  it("uses the pane's own shell quoting", async () => {
    const s = setup();
    const p = pane({ shell: "cmd" });
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["C:\\My Files\\a.txt"], position: { x: 2, y: 2 } });
    await flush();
    expect(p.calls[0]).toBe('write:"C:\\My Files\\a.txt" ');
    p.off();
    s.stop();
  });

  it("leaves out a path that cannot be written safely and reports the count once", async () => {
    const s = setup();
    const p = pane({ shell: "powershell" });
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["C:\\dl\\$(calc).txt", "C:\\a\nb", "C:\\ok.txt"], position: { x: 2, y: 2 } });
    await flush();
    expect(p.calls).toEqual(["write:'C:\\dl\\$(calc).txt' ", "write:C:\\ok.txt ", "focus"]);
    expect(s.onRejected).toHaveBeenCalledTimes(1);
    expect(s.onRejected).toHaveBeenCalledWith(1);
    p.off();
    s.stop();
  });

  it("marks the pane under the pointer while files hover, and unmarks on leave or drop", async () => {
    const s = setup();
    const a = pane();
    const b = pane();
    s.hit.mockReturnValue(a.el as never);
    s.send({ type: "enter", paths: ["/x"], position: { x: 1, y: 1 } });
    await flush();
    expect(a.h.classes.has("terminal-drop")).toBe(true);
    s.hit.mockReturnValue(b.el as never);
    s.send({ type: "over", position: { x: 9, y: 9 } });
    await flush();
    expect(a.h.classes.has("terminal-drop")).toBe(false);
    expect(b.h.classes.has("terminal-drop")).toBe(true);
    s.send({ type: "leave" });
    await flush();
    expect(b.h.classes.size).toBe(0);
    s.send({ type: "over", position: { x: 9, y: 9 } });
    await flush();
    s.send({ type: "drop", paths: [], position: { x: 9, y: 9 } });
    await flush();
    expect(b.h.classes.size).toBe(0);
    [a, b].forEach((p) => p.off());
    s.stop();
  });

  it("writes nothing with no pane under the pointer or a pty that has not started", async () => {
    const s = setup();
    const p = pane({ ready: false });
    s.hit.mockReturnValue(null);
    s.send({ type: "drop", paths: ["/a"], position: { x: 1, y: 1 } });
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["/a"], position: { x: 1, y: 1 } });
    s.send({ type: "drop", paths: ["/a"] });
    await flush();
    expect(p.target.write).not.toHaveBeenCalled();
    expect(p.target.focus).not.toHaveBeenCalled();
    p.off();
    s.stop();
  });

  it("a rejecting write reports once, stops, and does not focus", async () => {
    const s = setup();
    const p = pane({ write: async () => Promise.reject(new Error("gone")) });
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["/a", "/b"], position: { x: 1, y: 1 } });
    await flush();
    expect(s.onError).toHaveBeenCalledTimes(1);
    expect(p.target.write).toHaveBeenCalledTimes(1);
    expect(p.target.focus).not.toHaveBeenCalled();
    p.off();
    s.stop();
  });

  it("an unregistered pane gets nothing", async () => {
    const s = setup();
    const p = pane();
    p.off();
    s.hit.mockReturnValue(p.el as never);
    s.send({ type: "drop", paths: ["/a"], position: { x: 1, y: 1 } });
    await flush();
    expect(p.target.write).not.toHaveBeenCalled();
    s.stop();
  });

  it("stop releases the native listener, even when it is called before the listener is ready", async () => {
    const s = setup();
    await flush();
    s.stop();
    expect(s.unlisten).toHaveBeenCalledTimes(1);

    const unlisten = vi.fn();
    const early = startFileDrop({
      listen: async () => unlisten,
      scale: () => 1,
      hit: () => null,
      onError: () => {},
      onRejected: () => {},
    });
    early();
    await flush();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});
