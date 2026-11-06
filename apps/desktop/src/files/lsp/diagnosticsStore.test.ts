import { beforeEach, expect, it, vi } from "vitest";
import type { LspDiagnostic, LspEvent } from "@/api";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";
import { DiagnosticsStore, subscribeDiagnostics } from "./diagnosticsStore";

const d = (message: string): LspDiagnostic => ({ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message, source: null, code: null });
const t = (key: string, vars?: Record<string, string | number>) => `${key}${vars ? JSON.stringify(vars) : ""}`;

beforeEach(() => resetToastsForTests());

it("keeps diagnostics per file and tells the listeners", () => {
  const s = new DiagnosticsStore();
  const fn = vi.fn();
  const stop = s.subscribe(fn);
  s.set("/a", "x.ts", [d("one")]);
  expect(s.get("/a", "x.ts")).toHaveLength(1);
  expect(s.get("/b", "x.ts")).toHaveLength(0);
  expect(fn).toHaveBeenCalledWith("/a", "x.ts");
  s.set("/a", "x.ts", []);
  expect(s.get("/a", "x.ts")).toHaveLength(0);
  stop();
  s.set("/a", "x.ts", [d("two")]);
  expect(fn).toHaveBeenCalledTimes(2);
});

async function feed(events: LspEvent[]) {
  const store = new DiagnosticsStore();
  const restart = vi.fn();
  let push: (e: LspEvent) => void = () => undefined;
  const off = vi.fn();
  const api = {
    lspSubscribe: vi.fn(async (fn: (e: LspEvent) => void) => {
      push = fn;
      return off;
    }),
  };
  const stop = subscribeDiagnostics(api, { store, t: () => t, restart });
  await Promise.resolve();
  events.forEach(push);
  return { store, restart, stop, off };
}

it("stores pushed diagnostics", async () => {
  const { store } = await feed([{ kind: "diagnostics", worktree: "/a", rel: "x.ts", items: [d("m")] }]);
  expect(store.get("/a", "x.ts")[0].message).toBe("m");
});

it("offers a restart when a server crashed", async () => {
  const { restart } = await feed([{ kind: "status", worktree: "/a", language: "rust", state: "crashed" }]);
  const toast = getToasts()[0];
  expect(toast.text).toBe('lsp.crashed{"language":"Rust"}');
  toast.actions?.[0].run();
  expect(restart).toHaveBeenCalledWith("/a");
});

it("stops listening, even when stopped before the subscription arrived", async () => {
  const off = vi.fn();
  const api = { lspSubscribe: vi.fn(async () => off) };
  subscribeDiagnostics(api, { t: () => t, restart: vi.fn() })();
  await vi.waitFor(() => expect(off).toHaveBeenCalled());
});
