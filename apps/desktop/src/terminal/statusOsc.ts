import { parseOsc9Progress } from "./progress";
import { PROGRAM_STATUS_REPLY, parseProgramStatus, type ProgramStatusMessage } from "./programStatus";

export type ProgramReport = Extract<ProgramStatusMessage, { type: "report" }>;

export interface StatusOscDeps {
  /** Writes an answer to the pty. */
  reply(text: string): void;
  /** True while restored output is replayed: old probes get no answer. */
  replaying(): boolean;
  onProgramStatus?(report: ProgramReport): void;
  onProgress?(progress: number | null | "keep"): void;
}

interface OscParser {
  registerOscHandler(id: number, cb: (data: string) => boolean | Promise<boolean>): unknown;
}

/** Registers the OSC 7501 (program status) and OSC 9 (progress) handlers; each one takes the sequence. */
export function installStatusOsc(parser: OscParser, deps: StatusOscDeps): void {
  parser.registerOscHandler(7501, (data) => {
    const msg = parseProgramStatus(data);
    if (!msg) return true;
    if (msg.type === "query") {
      if (!deps.replaying()) deps.reply(PROGRAM_STATUS_REPLY);
      return true;
    }
    // A child record (`id=a/b`) belongs to a sub-task: only the program's own report moves the tab.
    if (msg.id === null) deps.onProgramStatus?.(msg);
    return true;
  });
  // OSC 9 also carries plain notification text; only `4;…` is progress.
  parser.registerOscHandler(9, (data) => {
    const p = parseOsc9Progress(data);
    if (p !== undefined) deps.onProgress?.(p);
    return true;
  });
}
