import { useState, type Dispatch, type SetStateAction } from "react";
import type { Api, Check, WorktreeView } from "@/api";
import type { SendChoice } from "@/workspace/agentPrompt";
import { sendCheckFix, sendChecksFix, sendCommentsFix, sendFix } from "@/workspace/fixAgent";
import type { PrCommentStore } from "@/workspace/prCommentStore";
import type { CommentGroup } from "@/workspace/prComments";
import type { SendOutcome } from "@/workspace/PrSendBar";
import type { Sessions } from "@/workspace/sessions";

type Front = { worktree: string; id: string; seq: number };

/** Hands a failure, a conflict, failing checks or PR comments to an agent of the worktree in front. */
export function useShellAgentFix(o: {
  api: Api;
  sessions: Sessions | null;
  current: WorktreeView | null;
  shownTab: Record<string, string | null>;
  prComments: PrCommentStore;
  target(path: string | undefined): { client: { input(text: string): Promise<unknown> } } | null;
  setFront: Dispatch<SetStateAction<Front | null>>;
}) {
  const { api, sessions, current, shownTab, prComments, target, setFront } = o;
  const [fixNote, setFixNote] = useState(false);

  // Types into the tab in front when it is a live agent tab. No Enter is sent, so the person reads it first.
  async function sendToAgent(text: string): Promise<boolean> {
    const tab = target(current?.path);
    if (!tab) return false;
    await tab.client.input(text);
    return true;
  }

  // Gives a failed commit hook's output to an agent of the worktree, as its recipe says, and brings its tab to the front.
  async function fixWithAgent(id: "fixCommitFailure" | "fixPushFailure", output: string, branch = current?.branch ?? ""): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendFix(api, sessions, path, shownTab[path] ?? null, id, { branch, output });
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives the conflicts of the operation in progress to an agent of the worktree, as its recipe says.
  async function resolveConflicts(vars: Record<string, string>): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendFix(api, sessions, path, shownTab[path] ?? null, "resolveConflicts", vars);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives every failing check, each with its log when there is one, to one agent prompt.
  async function fixChecks(checks: Check[]): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendChecksFix(api, sessions, path, shownTab[path] ?? null, current.branch ?? "", checks);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives a failed check, with its log when there is one, to an agent of the worktree.
  async function fixCheck(check: Check): Promise<void> {
    if (!sessions || !current) return;
    const path = current.path;
    const tab = await sendCheckFix(api, sessions, path, shownTab[path] ?? null, current.branch ?? "", check);
    setFixNote(!tab);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
  }

  // Gives the queued PR comments to the chosen agent tab; with `ack` on, resolves and replies after.
  async function sendComments(pr: { number: number; title: string; url: string }, groups: CommentGroup[], choice: SendChoice, ack: boolean): Promise<SendOutcome> {
    if (!sessions || !current) return { ok: false, summary: null };
    const path = current.path;
    const { tab, summary } = await sendCommentsFix(api, sessions, prComments, { ...pr, worktree: path, branch: current.branch ?? "" }, groups, choice, ack);
    if (tab) setFront((f) => ({ worktree: path, id: tab.id, seq: (f?.seq ?? 0) + 1 }));
    return { ok: tab !== null, summary };
  }

  return { fixNote, setFixNote, sendToAgent, fixWithAgent, resolveConflicts, fixChecks, fixCheck, sendComments };
}
