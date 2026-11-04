import type { Api, CliAsk, CliOpenTab, TabReport } from "./api";

type CliApi = Pick<Api, "cliTabsReport" | "cliApprove" | "onWorkspaceChanged" | "onCliOpenTab" | "onCliAsk">;

export type MockCli = CliApi & {
  // Every `cliTabsReport` call, oldest first.
  __cliReports(): { tabs: TabReport[]; selected: string | null }[];
  // Every `cliApprove` answer, oldest first.
  __cliAnswers(): { request: number; allow: boolean }[];
  // What the endpoint would send: a registry change, a tab to open, a question for the person.
  __cliWorkspaceChanged(): void;
  __cliOpenTab(e: CliOpenTab): void;
  __cliAsk(e: CliAsk): void;
};

/** The app CLI's side of the demo: no endpoint, so a test plays the CLI through the `__cli` hooks. */
export function createMockCli(): MockCli {
  const reports: { tabs: TabReport[]; selected: string | null }[] = [];
  const answers: { request: number; allow: boolean }[] = [];
  const changed = new Set<() => void>();
  const opens = new Set<(e: CliOpenTab) => void>();
  const asks = new Set<(e: CliAsk) => void>();
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
    __cliReports: () => structuredClone(reports),
    __cliAnswers: () => structuredClone(answers),
    __cliWorkspaceChanged: () => [...changed].forEach((cb) => cb()),
    __cliOpenTab: (e) => [...opens].forEach((cb) => cb(structuredClone(e))),
    __cliAsk: (e) => [...asks].forEach((cb) => cb(structuredClone(e))),
  };
}
