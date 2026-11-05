import type { Api, CliAsk, CliStatus, CliOpenTab, ReadTab, SkillStatus, TabReport, WorkerChanged, WorkerClose, WorkerLifetime, WorkerOpen, WorkerOpenOutcome } from "./api";

type CliApi = Pick<
  Api,
  | "cliTabsReport" | "cliApprove" | "onWorkspaceChanged" | "onCliOpenTab" | "onCliAsk"
  | "cliStatus" | "cliInstall" | "cliRemove" | "cliRepair" | "cliReveal"
  | "orchestrationSkillStatus"
  | "orchestrationSkillInstall"
  | "orchestrationSkillUninstall"
  | "orchestrationWorkerLifetime"
  | "orchestrationWorkerKeepOpen"
  | "orchestrationWorkerOpened"
  | "orchestrationReadAnswer"
  | "onOrchestrationOpenWorker"
  | "onOrchestrationCloseWorker"
  | "onOrchestrationReadTab"
  | "onOrchestrationWorkerChanged"
>;

export type MockCli = CliApi & {
  // Every `cliTabsReport` call, oldest first.
  __cliReports(): { tabs: TabReport[]; selected: string | null }[];
  // Every `cliApprove` answer, oldest first.
  __cliAnswers(): { request: number; allow: boolean }[];
  // What the endpoint would send: a registry change, a tab to open, a question for the person.
  __cliWorkspaceChanged(): void;
  __cliOpenTab(e: CliOpenTab): void;
  __cliAsk(e: CliAsk): void;
  // Orchestration: what the backend would send, and what the UI answered it.
  __orchOpenWorker(e: WorkerOpen): void;
  __orchCloseWorker(e: WorkerClose): void;
  __orchReadTab(e: ReadTab): void;
  __orchWorkerChanged(e: WorkerChanged): void;
  __orchOpened(): { dispatch: string; outcome: WorkerOpenOutcome }[];
  __orchReads(): { request: number; text: string }[];
  __orchSetLifetime(tab: string, v: WorkerLifetime | null): void;
  __orchInstalls(): boolean[];
  // The xdev-on-PATH state the page reads, and the calls it made (status excluded), oldest first.
  __cliSetStatus(s: Partial<CliStatus>): void;
  __cliInstallCalls(): string[];
};

const CLI_DEFAULT: CliStatus = { installed: false, targetPath: "/Applications/xDev/xdev", linkPath: "/home/me/.local/bin/xdev", onPath: true, stale: false };

const SKILL_DEFAULT: SkillStatus = { installed: false, edited: false, canonical: "~/.agents/skills/xdev-orchestration", agents: [], installCommand: "xdev skills install" };

/** The app CLI's side of the demo: no endpoint, so a test plays the CLI through the `__cli` hooks. */
export function createMockCli(): MockCli {
  const reports: { tabs: TabReport[]; selected: string | null }[] = [];
  const answers: { request: number; allow: boolean }[] = [];
  const changed = new Set<() => void>();
  const opens = new Set<(e: CliOpenTab) => void>();
  const asks = new Set<(e: CliAsk) => void>();
  const openWorker = new Set<(e: WorkerOpen) => void>();
  const closeWorker = new Set<(e: WorkerClose) => void>();
  const readTab = new Set<(e: ReadTab) => void>();
  const workerChanged = new Set<(e: WorkerChanged) => void>();
  const opened: { dispatch: string; outcome: WorkerOpenOutcome }[] = [];
  const reads: { request: number; text: string }[] = [];
  const installs: boolean[] = [];
  const lifetimes = new Map<string, WorkerLifetime>();
  let skill: SkillStatus = { ...SKILL_DEFAULT };
  let cli: CliStatus = { ...CLI_DEFAULT };
  const cliCalls: string[] = [];
  const on = <T>(set: Set<T>, cb: T) => {
    set.add(cb);
    return () => void set.delete(cb);
  };
  return {
    async cliTabsReport(tabs, selected) {
      reports.push({ tabs: structuredClone(tabs), selected });
    },
    async cliApprove(request, allow) {
      answers.push({ request, allow });
    },
    async onWorkspaceChanged(cb) {
      return on(changed, cb);
    },
    async onCliOpenTab(cb) {
      return on(opens, cb);
    },
    async onCliAsk(cb) {
      return on(asks, cb);
    },
    async cliStatus() {
      return { ...cli };
    },
    async cliInstall() {
      cliCalls.push("install");
      cli = { ...cli, installed: true, stale: false };
      return { ...cli };
    },
    async cliRemove() {
      cliCalls.push("remove");
      cli = { ...cli, installed: false, stale: false };
      return { ...cli };
    },
    async cliRepair() {
      cliCalls.push("repair");
      cli = { ...cli, installed: true, stale: false };
      return { ...cli };
    },
    async cliReveal() {
      cliCalls.push("reveal");
    },
    __cliSetStatus(s) {
      cli = { ...cli, ...s };
    },
    __cliInstallCalls() {
      return [...cliCalls];
    },
    async orchestrationSkillStatus() {
      return structuredClone(skill);
    },
    async orchestrationSkillInstall(force = false) {
      installs.push(force);
      skill = { ...skill, installed: true, edited: false };
      return structuredClone(skill);
    },
    async orchestrationSkillUninstall() {
      skill = { ...skill, installed: false, edited: false };
      return structuredClone(skill);
    },
    async orchestrationWorkerLifetime(tab) {
      const v = lifetimes.get(tab);
      return v ? { ...v } : null;
    },
    async orchestrationWorkerKeepOpen(tab, keep) {
      const next = { ...(lifetimes.get(tab) ?? { kept: false, closesAtMs: null, finished: false }), kept: keep };
      lifetimes.set(tab, next);
      return { ...next };
    },
    async orchestrationWorkerOpened(dispatch, outcome) {
      opened.push({ dispatch, outcome: structuredClone(outcome) });
    },
    async orchestrationReadAnswer(request, text) {
      reads.push({ request, text });
    },
    async onOrchestrationOpenWorker(cb) {
      return on(openWorker, cb);
    },
    async onOrchestrationCloseWorker(cb) {
      return on(closeWorker, cb);
    },
    async onOrchestrationReadTab(cb) {
      return on(readTab, cb);
    },
    async onOrchestrationWorkerChanged(cb) {
      return on(workerChanged, cb);
    },
    __orchOpenWorker: (e) => [...openWorker].forEach((cb) => cb(structuredClone(e))),
    __orchCloseWorker: (e) => [...closeWorker].forEach((cb) => cb(structuredClone(e))),
    __orchReadTab: (e) => [...readTab].forEach((cb) => cb(structuredClone(e))),
    __orchWorkerChanged: (e) => [...workerChanged].forEach((cb) => cb(structuredClone(e))),
    __orchOpened: () => structuredClone(opened),
    __orchReads: () => structuredClone(reads),
    __orchSetLifetime(tab, v) {
      if (v) lifetimes.set(tab, structuredClone(v));
      else lifetimes.delete(tab);
    },
    __orchInstalls: () => [...installs],
    __cliReports: () => structuredClone(reports),
    __cliAnswers: () => structuredClone(answers),
    __cliWorkspaceChanged: () => [...changed].forEach((cb) => cb()),
    __cliOpenTab: (e) => [...opens].forEach((cb) => cb(structuredClone(e))),
    __cliAsk: (e) => [...asks].forEach((cb) => cb(structuredClone(e))),
  };
}
