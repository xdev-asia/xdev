import type { Api, CliAsk } from "@/api";
import { openFile } from "@/files/openFile";
import { dismissToast, pushToast } from "./toastStore";

/** How long the person has to answer a CLI write; the backend gives up at the same time. */
export const ASK_TTL_MS = 60_000;

type T = (key: string, vars?: Record<string, string | number>) => string;

export interface CliEventHost {
  /** Loads the sidebar again. */
  reload(): void;
  /** Opens `profile` (empty: the default agent) in `worktree` without focusing it; types `prompt` once setup allows agents. */
  openTab(worktree: string, profile: string, prompt: string | null): void;
  t: T;
}

/** The last folder of a path, for a short toast. */
function leaf(path: string): string {
  return path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || path;
}

/** The words for each verb that can ask; another verb reads as a change of details. */
const VERB_KEYS: Record<string, string> = {
  "worktree.create": "cli.ask.create",
  "worktree.set": "cli.ask.set",
  "terminal.send": "cli.ask.send",
  "automation.run": "cli.ask.automation",
  "automation.enable": "cli.ask.automation",
  "automation.disable": "cli.ask.automation",
  "automation.remove": "cli.ask.automation",
};

/** The toast for one `cli://ask`: Allow / Deny, gone after 60 s with no answer sent. */
export function askToast(api: Api, ask: CliAsk, t: T): string {
  const id = `cli-ask-${ask.request}`;
  const verb = t(VERB_KEYS[ask.verb] ?? "cli.ask.set");
  const who = ask.caller === null ? t("cli.ask.external") : leaf(ask.caller);
  const answer = (allow: boolean) => () => {
    dismissToast(id);
    void api.cliApprove(ask.request, allow).catch(() => {});
  };
  return pushToast({
    id,
    text: t("cli.ask", { who, verb, target: leaf(ask.target) }),
    actions: [
      { label: t("cli.ask.allow"), run: answer(true) },
      { label: t("cli.ask.deny"), run: answer(false) },
    ],
    ttlMs: ASK_TTL_MS,
  });
}

/** Follows the endpoint's events until the returned stop is called. */
export function startCliEvents(api: Api, host: CliEventHost): () => void {
  const offs = [
    api.onWorkspaceChanged(() => host.reload()),
    api.onCliOpenTab((e) => host.openTab(e.worktree, e.profile, e.prompt)),
    api.onCliAsk((e) => void askToast(api, e, host.t)),
    api.onCliOpenFile((e) => openFile({ worktree: e.worktree, rel: e.path, line: e.line ?? undefined, column: e.column ?? undefined })),
  ];
  return () => {
    for (const off of offs) void off.then((stop) => stop()).catch(() => {});
  };
}
