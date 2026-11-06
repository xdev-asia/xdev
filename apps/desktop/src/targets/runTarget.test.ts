import { expect, it, vi } from "vitest";
import type { DeployPreset } from "@/api";
import { onOpenFile, type OpenFileRequest } from "@/files/openFile";
import type { Sessions } from "@/workspace/sessions";
import { openServerShell, runDeploy } from "./runTarget";

const t = (key: string, vars?: Record<string, string | number>) => `${key}:${vars?.name ?? ""}`;

function fake() {
  const typed: string[] = [];
  const open = vi.fn(() => ({ id: "tab1", client: { typeWhenReady: (s: string) => typed.push(s) } }));
  return { sessions: { open } as unknown as Sessions, open, typed };
}
const preset = (over: Partial<DeployPreset> = {}): DeployPreset => ({ name: "Prod", run: "vercel deploy --prod", confirm: false, source: "detected", ...over });

it("opens a titled shell tab and types the command with Enter", async () => {
  const f = fake();
  const r = await runDeploy(preset(), { sessions: f.sessions, worktree: "/wt", t });
  expect(r.ok).toBe(true);
  expect(f.open).toHaveBeenCalledWith("/wt", "shell", null, undefined, { title: "targets.deploy.tab:Prod" });
  expect(f.typed).toEqual(["vercel deploy --prod\r"]);
});

it("a confirm preset types nothing after Cancel, and runs after Run deploy", async () => {
  const f = fake();
  const no = await runDeploy(preset({ confirm: true }), { sessions: f.sessions, worktree: "/wt", t, confirm: async () => false });
  expect(no).toEqual({ ok: false, reason: "cancelled" });
  expect(f.open).not.toHaveBeenCalled();
  const yes = await runDeploy(preset({ confirm: true }), { sessions: f.sessions, worktree: "/wt", t, confirm: async () => true });
  expect(yes.ok).toBe(true);
  expect(f.typed).toEqual(["vercel deploy --prod\r"]);
});

it("the server shell opens ssh, goes to the folder and opens the notes beside it", async () => {
  const f = fake();
  const files: OpenFileRequest[] = [];
  const stop = onOpenFile((r) => files.push(r));
  const api = { targetsVpsNotes: async () => "docs/deploy.md" };
  await openServerShell({ host: "prod-1", cwd: "/srv/my app", notes: "docs/deploy.md" }, { api, sessions: f.sessions, worktree: "/wt" });
  stop();
  expect(f.open).toHaveBeenCalledWith("/wt", "shell:ssh:prod-1");
  expect(f.typed).toEqual(["cd '/srv/my app'\r"]);
  expect(files).toEqual([{ worktree: "/wt", rel: "docs/deploy.md", side: true }]);
});

it("without notes no file opens", async () => {
  const f = fake();
  const files: OpenFileRequest[] = [];
  const stop = onOpenFile((r) => files.push(r));
  await openServerShell({ host: "h", cwd: null, notes: null }, { api: { targetsVpsNotes: async () => null }, sessions: f.sessions, worktree: "/wt" });
  stop();
  expect(files).toEqual([]);
  expect(f.typed).toEqual([]);
});
