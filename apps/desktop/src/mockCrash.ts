import type { CrashDetail, CrashReport, RenderCrash, StartupStep } from "@xdev/bindings";
import type { Api } from "./api";

type CrashApi = Pick<
  Api,
  | "crashRecordRender"
  | "crashBreadcrumb"
  | "crashTakePending"
  | "crashLatest"
  | "crashDismiss"
  | "startupReport"
  | "startupMark"
  | "appRelaunch"
  | "diagnosticsExport"
  | "diagnosticsRevealLogs"
  | "pickDiagnosticsPath"
>;

export type MockCrash = CrashApi & {
  // Puts a report in the store as the newest, the way a panic on the last run would.
  __crash(report: CrashReport): void;
  // Marks a startup step as failed.
  __startupFail(id: string, detail: string): void;
  // The paths `diagnosticsExport` wrote to, in order.
  __exports(): string[];
  // How often `appRelaunch` ran.
  __relaunches(): number;
  // How often `diagnosticsRevealLogs` ran.
  __logReveals(): number;
};

/** `MAX_REPORTS` and `MAX_BREADCRUMBS` in `crash.rs`. */
export const MAX_REPORTS = 5;
export const MAX_BREADCRUMBS = 30;
const RELATED_MS = 5000;
export const MOCK_DIAGNOSTICS_PATH = "/demo/xdev-diagnostics.ndjson";

const STEPS = [
  "data_dir",
  "logs",
  "settings",
  "ptyd",
  "endpoint",
  "keybindings_watcher",
  "hooks_watcher",
  "hooks_marker",
  "crash_store",
];

type Crumb = CrashReport["breadcrumbs"][number];

/** The crash store, breadcrumbs, startup report and diagnostics export in memory, with the caps of the Rust side. */
export function createMockCrash(): MockCrash {
  let reports: CrashReport[] = [];
  const crumbs: Crumb[] = [];
  let seq = 0;
  const steps: StartupStep[] = STEPS.map((id) => ({ id, ok: true, ms: 1 }));
  const exports: string[] = [];
  let relaunches = 0;
  let logReveals = 0;

  const add = (r: CrashReport) => {
    reports = [r, ...reports].slice(0, MAX_REPORTS);
  };
  const upsertStep = (step: StartupStep) => {
    const i = steps.findIndex((s) => s.id === step.id);
    if (i >= 0) steps[i] = step;
    else steps.push(step);
  };

  return {
    async crashRecordRender(c: RenderCrash) {
      seq += 1;
      const details: CrashDetail[] = [
        { key: "boundary", value: c.boundary },
        { key: "surface", value: c.surface },
        { key: "error_name", value: c.name },
        { key: "message", value: c.message.slice(0, 500) },
        ...c.context,
      ];
      const report: CrashReport = {
        id: `mock-${seq}`,
        createdAt: Date.now(),
        status: "pending",
        source: "renderer",
        process: "react-render",
        reason: "react-error-boundary",
        exitCode: null,
        appVersion: "0.0.0",
        platform: "demo",
        arch: "demo",
        details,
        breadcrumbs: crumbs.map((x) => structuredClone(x)),
      };
      add(report);
      return structuredClone(report);
    },
    async crashBreadcrumb(name, data) {
      if (crumbs.length >= MAX_BREADCRUMBS) crumbs.shift();
      crumbs.push({ at: Date.now(), name: name.slice(0, 80), data } as Crumb);
    },
    async crashTakePending() {
      const r = reports.find((x) => x.status === "pending");
      if (!r) return null;
      const taken = structuredClone(r);
      r.status = "dismissed";
      return taken;
    },
    async crashLatest() {
      return reports[0] ? structuredClone(reports[0]) : null;
    },
    async crashDismiss(id) {
      const target = reports.find((r) => r.id === id);
      if (!target) return;
      for (const r of reports) {
        const related =
          r.status === "pending" &&
          r.reason === target.reason &&
          r.exitCode === target.exitCode &&
          r.appVersion === target.appVersion &&
          r.platform === target.platform &&
          Math.abs(r.createdAt - target.createdAt) <= RELATED_MS;
        if (r.id === id || related) r.status = "dismissed";
      }
    },
    async startupReport() {
      return { steps: structuredClone(steps) };
    },
    async startupMark(step) {
      upsertStep(structuredClone(step));
    },
    async appRelaunch() {
      relaunches += 1;
    },
    async diagnosticsExport(path) {
      exports.push(path);
      return 1024;
    },
    async diagnosticsRevealLogs() {
      logReveals += 1;
    },
    async pickDiagnosticsPath() {
      return MOCK_DIAGNOSTICS_PATH;
    },
    __crash: (report) => add(structuredClone(report)),
    __startupFail: (id, detail) => upsertStep({ id, ok: false, ms: 0, detail }),
    __exports: () => [...exports],
    __relaunches: () => relaunches,
    __logReveals: () => logReveals,
  };
}
