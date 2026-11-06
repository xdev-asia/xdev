import { describe, expect, it, vi } from "vitest";
import type { Tab } from "@/workspace/sessions";
import type { Shape } from "./annotModel";
import { captureTarget, finalPath, sendCapture, type SendDeps } from "./useCaptureHost";

const tab = (id: string, over: Partial<Tab> = {}): Tab => ({ id, agent: true, exitCode: undefined, asleep: false, title: null, client: { input: vi.fn(async () => {}) }, ...over }) as unknown as Tab;

const box: Shape = { id: "b", tool: "box", color: "danger", x: 0, y: 0, w: 10, h: 10 };

function deps(tabs: Tab[], over: Partial<SendDeps> = {}) {
  const notify = vi.fn();
  const d: SendDeps = {
    api: { captureSavePng: vi.fn(async () => "/saved/annotated.png") },
    sessions: { tabs: () => tabs },
    worktree: "/wt",
    shown: null,
    exportPng: vi.fn(async () => new Uint8Array([1])),
    bracketed: () => true,
    windows: false,
    notify,
    tabTitle: (t) => `tab ${t.id}`,
    ...over,
  };
  return { d, notify };
}

describe("captureTarget", () => {
  it("picks the shown tab when it is a live agent tab", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    expect(captureTarget(tabs, "b")?.id).toBe("b");
  });

  it("falls back to the latest live agent tab when the shown one is a shell, exited or asleep", () => {
    const tabs = [tab("a"), tab("b"), tab("shell", { agent: false }), tab("gone", { exitCode: 0 }), tab("zz", { asleep: true })];
    expect(captureTarget(tabs, "shell")?.id).toBe("b");
    expect(captureTarget(tabs, "gone")?.id).toBe("b");
    expect(captureTarget(tabs, null)?.id).toBe("b");
  });

  it("is null without a live agent tab", () => {
    expect(captureTarget([tab("s", { agent: false })], "s")).toBeNull();
    expect(captureTarget([], null)).toBeNull();
  });
});

describe("finalPath", () => {
  it("keeps the original path while nothing was drawn", async () => {
    const { d } = deps([]);
    expect(await finalPath(d, "/p/orig.png", [])).toBe("/p/orig.png");
    expect(d.api.captureSavePng).not.toHaveBeenCalled();
  });

  it("saves a new PNG when there are shapes", async () => {
    const { d } = deps([]);
    expect(await finalPath(d, "/p/orig.png", [box])).toBe("/saved/annotated.png");
    expect(d.api.captureSavePng).toHaveBeenCalledWith(new Uint8Array([1]));
  });
});

describe("sendCapture", () => {
  it("writes the original path, bracketed, into the shown agent tab", async () => {
    const a = tab("a");
    const b = tab("b");
    const { d, notify } = deps([a, b], { shown: "a" });
    expect(await sendCapture(d, "/p/orig.png", [])).toBe("sent");
    expect(a.client.input).toHaveBeenCalledWith("\x1b[200~/p/orig.png\x1b[201~");
    expect(b.client.input).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith("capture.sent", { tab: "tab a" });
  });

  it("sends the annotated PNG when shapes exist", async () => {
    const a = tab("a");
    const { d } = deps([a], { shown: "a" });
    await sendCapture(d, "/p/orig.png", [box]);
    expect(a.client.input).toHaveBeenCalledWith("\x1b[200~/saved/annotated.png\x1b[201~");
  });

  it("writes plain with a trailing space when bracketed paste is off", async () => {
    const a = tab("a");
    const { d } = deps([a], { shown: "a", bracketed: () => false });
    await sendCapture(d, "/p/orig.png", []);
    expect(a.client.input).toHaveBeenCalledWith("/p/orig.png ");
  });

  it("with no agent tab it says so and writes nothing", async () => {
    const { d, notify } = deps([tab("s", { agent: false })], { shown: "s" });
    expect(await sendCapture(d, "/p/orig.png", [box])).toBe("no-tab");
    expect(notify).toHaveBeenCalledWith("capture.noTab");
    expect(d.exportPng).not.toHaveBeenCalled();
  });

  it("with no worktree it is the same as no tab", async () => {
    const { d, notify } = deps([tab("a")], { worktree: null });
    expect(await sendCapture(d, "/p/orig.png", [])).toBe("no-tab");
    expect(notify).toHaveBeenCalledWith("capture.noTab");
  });

  it("a failed save or write is reported as a failure", async () => {
    const a = tab("a");
    const { d, notify } = deps([a], { shown: "a", api: { captureSavePng: vi.fn(async () => Promise.reject(new Error("disk"))) } });
    expect(await sendCapture(d, "/p/orig.png", [box])).toBe("failed");
    expect(notify).toHaveBeenCalledWith("capture.err.failed");
    expect(a.client.input).not.toHaveBeenCalled();
  });
});
