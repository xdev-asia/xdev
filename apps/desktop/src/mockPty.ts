import type { AccountSource, Api, ApiError, Provider, PtyExit, PtyInfo, PtyProfile, PtydStatus, SessionInfo, SETUP_PROFILE as SetupProfile } from "./api";
import type { MockProfiles } from "./mockProfiles";
import type { MockSetupRun } from "./mockWorkspace";

type PtyApi = Pick<
  Api,
  | "ptySpawn"
  | "ptyApprove"
  | "ptyWrite"
  | "ptyResize"
  | "ptyAck"
  | "ptyKill"
  | "onPtyExit"
  | "ptyAttach"
  | "ptydStatus"
  | "ptydSessions"
  | "ptydEnd"
  | "ptydEndAll"
  | "ptydRestart"
  | "ptydQuitChoice"
  | "onPtydStatus"
>;

/** A pty the demo's terminal service holds, as a test seeds it. */
export interface MockHeld {
  id: string;
  /** What it printed while no tab was attached; replayed from the attach's `fromSeq`. */
  output?: string;
  info?: Partial<PtyInfo>;
  meta?: SessionInfo["meta"];
  /** The ring dropped this many bytes from the front. */
  lost?: number;
}

export type MockPtyd = {
  // Moves the demo's terminal service to `status` and fires `ptyd://status`.
  __ptydSet(status: Partial<PtydStatus> & Pick<PtydStatus, "state">): void;
  // A pty the service runs with no tab attached, as after a restart of the app.
  __ptydHold(held: MockHeld): void;
  // The last `ptydQuitChoice` answer; null when none was given.
  __quitChoice(): boolean | null;
  // The `prompt` each `ptySpawn` got, by pty id; absent when it had none.
  __prompts(): Record<string, string>;
};

const PROMPT = "$ ";
// `SETUP_PROFILE`, not imported: api.ts builds the mock api when it loads.
const SETUP_PROFILE: typeof SetupProfile = "xdev:setup";
const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * An echo terminal: what is typed comes back, Enter starts a new prompt. Agents need approval
 * once; an agent running as `skip` needs it before every start.
 */
export function createMockPty(
  profiles: Pick<MockProfiles, "__launchError" | "__permissions"> & Partial<Pick<MockProfiles, "__account" | "__promptAfter">>,
  // The setup script of the worktree at `cwd`, for `SETUP_PROFILE`.
  setupRun: (cwd: string) => Promise<MockSetupRun> = () => reject("hook_none", "setup"),
  // The provider's active account, which a built-in agent with no account of its own runs as.
  activeAccount: (provider: Provider) => string | null = () => null,
): PtyApi & MockPtyd {
  // Like Rust, an exited terminal keeps its slot until `ptyKill`.
  const ptys = new Map<string, { onData: (bytes: Uint8Array) => void; line: string; exited: boolean }>();
  const approved = new Set<PtyProfile>();
  const approvedOnce = new Set<PtyProfile>();
  const exits = new Set<(exit: PtyExit) => void>();
  // The demo has no terminal service until a test says so: terminals run in the app.
  let status: PtydStatus = { state: "off", serviceVersion: null, reason: null };
  const statusListeners = new Set<(s: PtydStatus) => void>();
  const held = new Map<string, MockHeld & { info: PtyInfo; startedMs: number }>();
  let quitChoice: boolean | null = null;
  const prompts: Record<string, string> = {};
  const serviceUp = () => status.state === "running" || status.state === "old-version";
  const setStatus = (next: PtydStatus) => {
    status = next;
    for (const cb of statusListeners) cb({ ...status });
  };
  const shellInfo = (id: string): PtyInfo => ({
    id,
    pid: null,
    program: "sh",
    agent: false,
    profile: "shell",
    permissions: "ask",
    account: null,
    accountSource: null,
    hooks: false,
    cli: null,
    hookEvents: [],
    promptAfter: null,
  });
  const end = (id: string) => {
    held.delete(id);
    const pty = ptys.get(id);
    if (pty && !pty.exited) {
      pty.exited = true;
      for (const cb of exits) cb({ id, code: null });
    }
  };

  return {
    async ptySpawn(id, cwd, profileId, account, _cols, _rows, onData, resume, fork, prompt) {
      if (prompt !== undefined) prompts[id] = prompt;
      if (profileId === SETUP_PROFILE) {
        if (ptys.has(id)) return reject("pty_exists");
        const run = await setupRun(cwd);
        ptys.set(id, { onData, line: "", exited: false });
        onData(encode(`${run.text.replace(/\r?\n/g, "\r\n")}\r\n`));
        // The script ends on its own, after the caller has the terminal.
        setTimeout(() => {
          const pty = ptys.get(id);
          if (!pty || pty.exited) return;
          pty.exited = true;
          for (const cb of exits) cb({ id, code: run.code });
        }, 0);
        return {
          id,
          pid: null,
          program: "sh",
          agent: false,
          profile: profileId,
          permissions: "ask",
          account: null,
          accountSource: null,
          hooks: false,
          cli: null,
          hookEvents: [],
          promptAfter: null,
        };
      }
      const refused = profiles.__launchError(profileId);
      if (refused) return reject(refused);
      if (ptys.has(id)) return reject("pty_exists");
      const agent = !profileId.startsWith("shell");
      // Like Rust: only an agent resumes, and the id is a plain token.
      if (resume !== undefined && (!agent || !SESSION_ID.test(resume))) return reject("bad_arg", "resume");
      // A fork continues a copy of a session, so it needs the id too.
      if (fork && resume === undefined) return reject("bad_arg", "fork");
      const permissions = agent ? (profiles.__permissions(profileId) ?? "ask") : "ask";
      if (agent) {
        // A skip launch is approved for one start only.
        const ok = permissions === "skip" ? approvedOnce.delete(profileId) : approved.has(profileId);
        if (!ok) return reject("needs_approval", `start ${profileId} in a terminal`);
      }
      // Like Rust `resolve`: the tab's account, else the profile's, else the provider's active one.
      const provider: Provider | null = profileId === "claude" || profileId === "codex" ? profileId : null;
      const own = agent ? (profiles.__account?.(profileId) ?? null) : null;
      const active = provider ? activeAccount(provider) : null;
      const [runAs, accountSource]: [string | null, AccountSource | null] = !agent
        ? [null, null]
        : account
          ? [account, "tab"]
          : own
            ? [own, "profile"]
            : active
              ? [active, "active"]
              : [null, null];
      ptys.set(id, { onData, line: "", exited: false });
      onData(encode(`xDev demo terminal (${profileId})\r\n${PROMPT}`));
      return {
        id,
        pid: null,
        program: agent ? profileId : "sh",
        agent,
        profile: profileId,
        permissions,
        account: runAs,
        accountSource,
        // Built-in agents get hook flags while Status hooks is on: claude past the version gate, codex on its private home.
        hooks: profileId === "claude" || profileId === "codex",
        cli: profileId === "claude" || profileId === "codex" ? profileId : null,
        hookEvents:
          profileId === "claude"
            ? ["prompt", "needs-input", "resume", "turn-failed", "turn-done"]
            : profileId === "codex"
              ? ["prompt", "needs-input", "resume", "turn-done", "interrupt"]
              : [],
        promptAfter: prompt !== undefined && profiles.__promptAfter?.(profileId) ? prompt : null,
      };
    },
    async ptyApprove(profileId) {
      if (profiles.__permissions(profileId) === "skip") approvedOnce.add(profileId);
      else approved.add(profileId);
    },
    async ptyWrite(id, data) {
      const pty = ptys.get(id);
      if (!pty) return reject("pty_unknown");
      if (pty.exited) return;
      // Each "\r" ends a line; the last piece is still being typed.
      const [first, ...rest] = new TextDecoder().decode(data).split("\r");
      for (const [i, piece] of [first, ...rest].entries()) {
        if (i > 0) {
          if (pty.line.trim() === "exit") {
            pty.exited = true;
            pty.onData(encode("\r\n"));
            for (const cb of exits) cb({ id, code: 0 });
            return;
          }
          pty.line = "";
          pty.onData(encode(`\r\n${PROMPT}`));
        }
        if (piece) {
          pty.line += piece;
          pty.onData(encode(piece));
        }
      }
    },
    async ptyResize(id) {
      if (!ptys.has(id)) return reject("pty_unknown");
    },
    async ptyAck(id) {
      if (!ptys.has(id)) return reject("pty_unknown");
    },
    async ptyKill(id) {
      const pty = ptys.get(id);
      ptys.delete(id);
      // Like Rust, killing a live terminal reports its exit.
      if (pty && !pty.exited) {
        pty.exited = true;
        for (const cb of exits) cb({ id, code: null });
      }
    },
    async onPtyExit(cb) {
      exits.add(cb);
      return () => exits.delete(cb);
    },
    async ptyAttach(id, fromSeq, onData) {
      const pty = held.get(id);
      if (!serviceUp() || !pty) return reject("pty_gone");
      if (ptys.has(id)) return reject("pty_exists");
      const bytes = encode(pty.output ?? "");
      const lost = pty.lost ?? 0;
      // `fromSeq` counts from the pty's first byte; the ring starts `lost` bytes in.
      const start = Math.max(fromSeq, lost);
      const seq = Math.min(start, lost + bytes.length);
      ptys.set(id, { onData, line: "", exited: false });
      const replay = bytes.slice(seq - lost);
      if (replay.length) setTimeout(() => onData(replay), 0);
      return { info: { ...pty.info, id }, seq, truncated: fromSeq < lost };
    },
    async ptydStatus() {
      return { ...status };
    },
    async ptydSessions() {
      if (!serviceUp()) return [];
      return [...held.values()].map((p) => ({
        id: p.id,
        pid: p.info.pid,
        program: p.info.program,
        cwd: p.meta?.worktree ?? "/demo",
        startedMs: p.startedMs,
        lastOutputMs: p.startedMs,
        lastInputMs: p.startedMs,
        meta: p.meta ?? { tabId: p.id, profile: p.info.profile },
        attached: ptys.has(p.id),
        exited: null,
      }));
    },
    async ptydEnd(id) {
      if (!serviceUp()) return reject("ptyd_unreachable");
      end(id);
    },
    async ptydEndAll() {
      if (!serviceUp()) return reject("ptyd_unreachable");
      for (const id of [...held.keys()]) end(id);
    },
    async ptydRestart() {
      for (const id of [...held.keys()]) end(id);
      setStatus({ state: "running", serviceVersion: "demo", reason: null });
    },
    async ptydQuitChoice(endAll) {
      quitChoice = endAll;
    },
    async onPtydStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    __ptydSet(next) {
      setStatus({ serviceVersion: null, reason: null, ...next });
    },
    __ptydHold(h) {
      held.set(h.id, { ...h, info: { ...shellInfo(h.id), ...h.info }, startedMs: Date.now() });
    },
    __quitChoice: () => quitChoice,
    __prompts: () => ({ ...prompts }),
  };
}
