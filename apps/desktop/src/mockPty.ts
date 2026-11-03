import type { Api, ApiError, PtyExit, PtyProfile } from "./api";
import type { MockProfiles } from "./mockProfiles";

type PtyApi = Pick<Api, "ptySpawn" | "ptyApprove" | "ptyWrite" | "ptyResize" | "ptyAck" | "ptyKill" | "onPtyExit">;

const PROMPT = "$ ";

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

const encode = (text: string) => new TextEncoder().encode(text);

/**
 * An echo terminal: what is typed comes back, Enter starts a new prompt. Agents need approval
 * once; an agent running as `skip` needs it before every start.
 */
export function createMockPty(profiles: Pick<MockProfiles, "__knows" | "__permissions">): PtyApi {
  // Like Rust, an exited terminal keeps its slot until `ptyKill`.
  const ptys = new Map<string, { onData: (bytes: Uint8Array) => void; line: string; exited: boolean }>();
  const approved = new Set<PtyProfile>();
  const approvedOnce = new Set<PtyProfile>();
  const exits = new Set<(exit: PtyExit) => void>();

  return {
    async ptySpawn(id, _cwd, profileId, account, _cols, _rows, onData) {
      if (!profiles.__knows(profileId)) return reject("unknown_profile");
      if (ptys.has(id)) return reject("pty_exists");
      const agent = !profileId.startsWith("shell");
      const permissions = agent ? (profiles.__permissions(profileId) ?? "ask") : "ask";
      if (agent) {
        // A skip launch is approved for one start only.
        const ok = permissions === "skip" ? approvedOnce.delete(profileId) : approved.has(profileId);
        if (!ok) return reject("needs_approval", `start ${profileId} in a terminal`);
      }
      ptys.set(id, { onData, line: "", exited: false });
      onData(encode(`xDev demo terminal (${profileId})\r\n${PROMPT}`));
      return {
        id,
        pid: null,
        program: agent ? profileId : "sh",
        agent,
        profile: profileId,
        permissions,
        account,
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
