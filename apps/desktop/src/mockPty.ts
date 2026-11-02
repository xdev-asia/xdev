import type { Api, ApiError, PtyExit, PtyProfile } from "./api";

type PtyApi = Pick<Api, "ptySpawn" | "ptyApprove" | "ptyWrite" | "ptyResize" | "ptyAck" | "ptyKill" | "onPtyExit">;

const PROMPT = "$ ";

function reject(code: ApiError["code"], detail?: string): Promise<never> {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
}

const encode = (text: string) => new TextEncoder().encode(text);

/** An echo terminal: what is typed comes back, Enter starts a new prompt. Agents need approval once. */
export function createMockPty(): PtyApi {
  // Like Rust, an exited terminal keeps its slot until `ptyKill`.
  const ptys = new Map<string, { onData: (bytes: Uint8Array) => void; line: string; exited: boolean }>();
  const approved = new Set<PtyProfile>();
  const exits = new Set<(exit: PtyExit) => void>();

  return {
    async ptySpawn(id, _cwd, profileId, _cols, _rows, onData) {
      if (!["shell", "claude", "codex"].includes(profileId)) return reject("unknown_profile");
      if (ptys.has(id)) return reject("pty_exists");
      const agent = profileId !== "shell";
      if (agent && !approved.has(profileId)) {
        return reject("needs_approval", `start ${profileId} in a terminal`);
      }
      ptys.set(id, { onData, line: "", exited: false });
      onData(encode(`xDev demo terminal (${profileId})\r\n${PROMPT}`));
      return { id, pid: null, program: profileId === "shell" ? "sh" : profileId, agent };
    },
    async ptyApprove(profileId) {
      approved.add(profileId);
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
      ptys.delete(id);
    },
    async onPtyExit(cb) {
      exits.add(cb);
      return () => exits.delete(cb);
    },
  };
}
