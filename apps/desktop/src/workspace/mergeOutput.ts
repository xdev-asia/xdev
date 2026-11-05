/** One tab's output with the heading it gets. */
export interface MergePart {
  title: string;
  agent: string;
  text: string;
}

export interface Merged {
  text: string;
  /** The text was cut at the size cap. */
  cut: boolean;
  /** Tabs that made it into the text (empty tabs are skipped). */
  tabs: number;
}

/** The most UTF-8 bytes a merged document keeps. */
export const MERGE_MAX_BYTES = 2 * 1024 * 1024;

// CSI, OSC (to BEL or ST), other two-byte escapes, and C0 controls but `\n` and `\t`.
// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]|\u001b[ -/]*[0-~]?/g;
// eslint-disable-next-line no-control-regex
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Removes escape sequences and control characters; `\r\n` becomes `\n`. */
export function stripAnsi(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(ANSI, "").replace(CONTROLS, "");
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: false });

/** The first `bytes` bytes of `text`, ending on a whole character and, when it can, on a whole line. */
function clip(text: string, bytes: number): string {
  if (bytes <= 0) return "";
  const cut = decoder.decode(encoder.encode(text).slice(0, bytes)).replace(/�+$/, "");
  const nl = cut.lastIndexOf("\n");
  return nl > 0 ? cut.slice(0, nl) : cut;
}

/**
 * One plain-text document from several tabs' output, in the order given. Each section is headed by the
 * tab title and agent; ANSI is stripped and a tab with no output is skipped. The result holds at most
 * `maxBytes` UTF-8 bytes; `cut` says it was shortened.
 */
export function mergeOutput(parts: readonly MergePart[], maxBytes: number = MERGE_MAX_BYTES): Merged {
  const sections: string[] = [];
  let used = 0;
  let cut = false;
  for (const p of parts) {
    const body = stripAnsi(p.text).replace(/^\n+/, "").trimEnd();
    if (body === "") continue;
    const head = `=== ${p.title} (${p.agent}) ===\n`;
    const sep = sections.length > 0 ? 2 : 0;
    const room = maxBytes - used - sep - encoder.encode(head).length;
    if (room <= 0) {
      cut = true;
      break;
    }
    const size = encoder.encode(body).length;
    const kept = size > room ? clip(body, room) : body;
    if (size > room) cut = true;
    sections.push(`${head}${kept}`);
    used += sep + encoder.encode(head).length + encoder.encode(kept).length;
    if (cut) break;
  }
  return { text: sections.join("\n\n"), cut, tabs: sections.length };
}
