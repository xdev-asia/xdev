import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi, type PortScan } from "@/api";
import { PortsStore } from "./portsStore";

const W = ["/demo/wt/xdev-oak"];

function scan(n = 0): PortScan {
  return { platform: "windows", scannedAt: n, ports: [], unavailable: null, detail: null, retryIn: null };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup() {
  const api = createMockApi({});
  const scanSpy = vi.spyOn(api, "portsScan");
  const store = new PortsStore(api);
  store.setWorktrees(W);
  return { api, store, scanSpy };
}

it("polls every 5 s only while visible", async () => {
  const { store, scanSpy } = setup();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(scanSpy).not.toHaveBeenCalled();
  store.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.setVisible(false);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(3);
  expect(scanSpy).toHaveBeenCalledWith(W, true);
  store.dispose();
});

it("scans that overlap share one call", async () => {
  const { store, scanSpy } = setup();
  const a = store.refresh();
  const b = store.refresh();
  expect(b).toBe(a);
  await a;
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await store.refresh();
  expect(scanSpy).toHaveBeenCalledTimes(2);
});

it("a printed URL forces a scan and one more a second later", async () => {
  const api = createMockApi({});
  let fire: () => void = () => undefined;
  vi.spyOn(api, "onPortsAdvertised").mockImplementation(async (cb) => {
    fire = () => cb("/demo/wt/xdev-oak");
    return () => undefined;
  });
  const scanSpy = vi.spyOn(api, "portsScan");
  const store = new PortsStore(api);
  store.setWorktrees(W);
  await store.watch();
  fire();
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.dispose();
});

it("the last good list survives one failed call and not two", async () => {
  const { api, store } = setup();
  await store.refresh();
  expect(store.state().scan?.ports.length).toBeGreaterThan(0);
  vi.spyOn(api, "portsScan").mockRejectedValue({ code: "scan_failed" });
  await store.refresh();
  expect(store.state().scan?.ports.length).toBeGreaterThan(0);
  expect(store.state().error?.code).toBe("scan_failed");
  await store.refresh();
  expect(store.state().scan).toBeNull();
});

it("a good scan clears the error and notifies subscribers", async () => {
  const { api, store } = setup();
  const seen = vi.fn();
  store.subscribe(seen);
  vi.spyOn(api, "portsScan").mockRejectedValueOnce({ code: "scan_failed" }).mockResolvedValue(scan(1));
  await store.refresh();
  expect(store.state().error).not.toBeNull();
  await store.refresh();
  expect(store.state().error).toBeNull();
  expect(store.state().scan?.scannedAt).toBe(1);
  expect(seen).toHaveBeenCalled();
  expect(store.snapshot()).toBeGreaterThan(0);
});

it("stopping a port shows the new list and scans again after 500 ms", async () => {
  const { store, scanSpy } = setup();
  await store.refresh();
  const first = store.state().scan?.ports[0];
  expect(first).toBeDefined();
  await store.stop(first!.id, { confirmed: true, outsideTerminal: false });
  expect(store.state().scan?.ports.some((p) => p.id === first!.id)).toBe(false);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(500);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.dispose();
});

it("a failed stop still scans again after 500 ms", async () => {
  const { api, store, scanSpy } = setup();
  vi.spyOn(api, "portsStop").mockRejectedValue(Object.assign(new Error("x"), { code: "port_changed" }));
  await expect(store.stop("localhost:1:1", { confirmed: true, outsideTerminal: false })).rejects.toMatchObject({ code: "port_changed" });
  expect(scanSpy).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(500);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  store.dispose();
});

it("a stop that ends after dispose starts no timer and no scan", async () => {
  const { api, store, scanSpy } = setup();
  let done: (s: PortScan) => void = () => undefined;
  vi.spyOn(api, "portsStop").mockReturnValue(new Promise((r) => { done = r; }));
  const stopping = store.stop("localhost:1:1", { confirmed: true, outsideTerminal: false });
  store.dispose();
  done(scan(2));
  await stopping;
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(scanSpy).not.toHaveBeenCalled();
});

it("a scan that started before a stop finished does not replace the list the stop returned", async () => {
  const { api, store, scanSpy } = setup();
  const pending: ((s: PortScan) => void)[] = [];
  scanSpy.mockImplementation(() => new Promise((r) => { pending.push(r); }));
  vi.spyOn(api, "portsStop").mockResolvedValue(scan(2));
  const before = store.refresh();
  await store.stop("localhost:1:1", { confirmed: true, outsideTerminal: false });
  const after = store.state().scan;
  expect(after?.scannedAt).toBe(2);
  pending[0]!(scan(1));
  await before;
  expect(store.state().scan).toBe(after);
  expect(store.state().loading).toBe(false);
  // The scan after the stop runs on its own, not on the stale one, and its result counts.
  await vi.advanceTimersByTimeAsync(500);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  pending[1]!(scan(3));
  await vi.advanceTimersByTimeAsync(0);
  expect(store.state().scan?.scannedAt).toBe(3);
  store.dispose();
});

it("a scan still running when the stop ends is not shared with the scan after it", async () => {
  const { api, store, scanSpy } = setup();
  const pending: ((s: PortScan) => void)[] = [];
  scanSpy.mockImplementation(() => new Promise((r) => { pending.push(r); }));
  let done: (s: PortScan) => void = () => undefined;
  vi.spyOn(api, "portsStop").mockReturnValue(new Promise((r) => { done = r; }));
  const stopping = store.stop("localhost:1:1", { confirmed: true, outsideTerminal: false });
  const during = store.refresh();
  done(scan(2));
  await stopping;
  const fresh = store.refresh();
  expect(fresh).not.toBe(during);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  pending[1]!(scan(3));
  await fresh;
  pending[0]!(scan(1));
  await during;
  expect(store.state().scan?.scannedAt).toBe(3);
  expect(store.state().loading).toBe(false);
  store.dispose();
});

it("new worktrees force a scan while visible", async () => {
  const { store, scanSpy } = setup();
  store.setVisible(true);
  await vi.advanceTimersByTimeAsync(0);
  store.setWorktrees([...W, "/demo/wt/other"]);
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.dispose();
});

it("slows to every 30 s while the window is hidden and scans when it shows again", async () => {
  const { store, scanSpy } = setup();
  store.setHidden(true);
  await vi.advanceTimersByTimeAsync(60_000);
  // Hidden alone starts nothing: no surface reads the list.
  expect(scanSpy).not.toHaveBeenCalled();
  store.want("cards", true);
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(29_000);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(scanSpy).toHaveBeenCalledTimes(2);
  store.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(scanSpy).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(scanSpy).toHaveBeenCalledTimes(4);
  store.dispose();
});

it("shares one scan between a poll and a forced refresh", async () => {
  const { store, scanSpy } = setup();
  let finish: (s: PortScan) => void = () => {};
  scanSpy.mockImplementation(() => new Promise<PortScan>((done) => { finish = done; }));
  store.setVisible(true);
  const forced = store.refresh();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(scanSpy).toHaveBeenCalledTimes(1);
  finish(scan(1));
  await forced;
  expect(store.state().scan?.scannedAt).toBe(1);
  store.dispose();
});
