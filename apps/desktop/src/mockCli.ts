import type { Api } from "./api";

type CliApi = Pick<Api, "cliTabsReport" | "cliApprove" | "onWorkspaceChanged" | "onCliOpenTab" | "onCliAsk">;

/** The app CLI's side of the demo: no endpoint, so nothing ever calls in. */
export function createMockCli(): CliApi {
  return {
    async cliTabsReport() {},
    async cliApprove() {},
    async onWorkspaceChanged() {
      return () => {};
    },
    async onCliOpenTab() {
      return () => {};
    },
    async onCliAsk() {
      return () => {};
    },
  };
}
