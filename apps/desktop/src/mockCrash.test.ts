import { describe, expect, it } from "vitest";
import type { CrashReport } from "@xdev/bindings";
import { createMockCrash, MAX_BREADCRUMBS, MAX_REPORTS, MOCK_DIAGNOSTICS_PATH } from "./mockCrash";

const render = (n: number) => ({
  boundary: "surface",
  surface: `s${n}`,
  name: "Error",
  message: `boom ${n}`,
  stack: null,
  componentStack: null,
  context: [],
});

const panic = (id: string, createdAt: number): CrashReport => ({
  id,
  createdAt,
  status: "pending",
  source: "main",
  process: "app",
  reason: "panic",
  exitCode: null,
  appVersion: "1",
  platform: "p",
  arch: "a",
  details: [],
  breadcrumbs: [],
});

describe("mock crash store", () => {
  it("keeps at most five reports, newest first", async () => {
    const m = createMockCrash();
    for (let i = 0; i < MAX_REPORTS + 2; i++) await m.crashRecordRender(render(i));
    const latest = await m.crashLatest();
    expect(latest?.details.find((d) => d.key === "surface")?.value).toBe(`s${MAX_REPORTS + 1}`);
  });

  it("keeps the last 30 breadcrumbs in the next report", async () => {
    const m = createMockCrash();
    for (let i = 0; i < MAX_BREADCRUMBS + 5; i++) await m.crashBreadcrumb(`b${i}`, []);
    const r = await m.crashRecordRender(render(0));
    expect(r?.breadcrumbs).toHaveLength(MAX_BREADCRUMBS);
    expect(r?.breadcrumbs[0].name).toBe("b5");
  });

  it("hands out a pending report once", async () => {
    const m = createMockCrash();
    m.__crash(panic("a", 1000));
    expect((await m.crashTakePending())?.id).toBe("a");
    expect(await m.crashTakePending()).toBeNull();
    expect((await m.crashLatest())?.id).toBe("a");
  });

  it("dismisses pending reports of the same storm", async () => {
    const m = createMockCrash();
    m.__crash(panic("old", 1000));
    m.__crash(panic("x", 100_000));
    m.__crash(panic("y", 101_000));
    await m.crashDismiss("y");
    // Only the unrelated old report stays pending.
    expect((await m.crashTakePending())?.id).toBe("old");
    expect(await m.crashTakePending()).toBeNull();
  });

  it("marks a startup step failed and records exports", async () => {
    const m = createMockCrash();
    expect((await m.startupReport()).steps.every((s) => s.ok)).toBe(true);
    m.__startupFail("settings", "bad");
    expect((await m.startupReport()).steps.find((s) => s.id === "settings")).toMatchObject({ ok: false, detail: "bad" });
    const path = await m.pickDiagnosticsPath("x.ndjson");
    expect(path).toBe(MOCK_DIAGNOSTICS_PATH);
    await m.diagnosticsExport(path!);
    await m.appRelaunch();
    expect(m.__exports()).toEqual([MOCK_DIAGNOSTICS_PATH]);
    expect(m.__relaunches()).toBe(1);
  });
});
