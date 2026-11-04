import type { AccountSource, Api, ApiError, Provider, PtyExit, PtyProfile, SETUP_PROFILE as SetupProfile } from "./api";
import type { MockProfiles } from "./mockProfiles";
import type { MockSetupRun } from "./mockWorkspace";

type PtyApi = Pick<Api, "ptySpawn" | "ptyApprove" | "ptyWrite" | "ptyResize" | "ptyAck" | "ptyKill" | "onPtyExit">;

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
  profiles: Pick<MockProfiles, "__launchError" | "__permissions"> & Partial<Pick<MockProfiles, "__account">>,
  // The setup script of the worktree at `cwd`, for `SETUP_PROFILE`.
  setupRun: (cwd: string) => Promise<MockSetupRun> = () => reject("hook_none", "setup"),
  // The provider's active account, which a built-in agent with no account of its own runs as.
  activeAccount: (provider: Provider) => string | null = () => null,
): PtyApi {
  // Like Rust, an exited terminal keeps its slot until `ptyKill`.
  const ptys = new Map<string, { onData: (bytes: Uint8Array) => void; line: string; exited: boolean }>();
  const approved = new Set<PtyProfile>();
  const approvedOnce = new Set<PtyProfile>();
  const exits = new Set<(exit: PtyExit) => void>();

  return {
    async ptySpawn(id, cwd, profileId, account, _cols, _rows, onData, resume) {
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
        };
      }
      const refused = profiles.__launchError(profileId);
      if (refused) return reject(refused);
      if (ptys.has(id)) return reject("pty_exists");
      const agent = !profileId.startsWith("shell");
      // Like Rust: only an agent resumes, and the id is a plain token.
      if (resume !== undefined && (!agent || !SESSION_ID.test(resume))) return reject("bad_arg", "resume");
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
  };
}
