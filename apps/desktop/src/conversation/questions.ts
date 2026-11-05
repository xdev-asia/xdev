// The question an agent stopped on, and the keys that answer it. Pure: no React, no api.
//
// Two sources:
// - the hook detail of a `needs-input` (claude sends the question; see `hooks/question.rs`);
// - else the last assistant turn of the transcript, when the tab rests at its prompt.
//
// What is sent:
// - a CLI menu (claude's permission dialog, AskUserQuestion): the option's digit, no Enter;
//   a permission is refused with Escape;
// - a question asked in the text of a turn: the answer typed at the prompt, then Enter.
// Any other case is answered in the terminal: `answerable` is false.
import type { HookDetail, HookQuestion } from "@/api";

export type QuestionKind = "permission" | "choice" | "yes-no" | "input";

export interface QuestionChoice {
  label: string;
  description: string | null;
  /** The bytes written to the pty when it is picked. */
  keys: string;
}

export interface Question {
  source: "hook" | "transcript";
  kind: QuestionKind;
  /** The question; empty for a permission (`tool` says what it is about). */
  text: string;
  header: string | null;
  /** The tool a permission is for, and a short line of its input. */
  tool: string | null;
  toolInput: string | null;
  choices: QuestionChoice[];
  /** False when the format is not known for sure: the person answers in the terminal. */
  answerable: boolean;
}

/** The CLIs whose question formats this file knows. */
export type QuestionCli = "claude" | "codex" | null;

const ENTER = "\r";
const ESCAPE = "\x1b";

/**
 * The question of a `needs-input` hook. A hook with no question still makes one (kind `input`), so
 * the card can say the agent waits and point to the terminal.
 *
 * Only claude's menus get keys: the digit of a choice of one question, and `1` / Escape for a permission.
 * Several questions in one call, a multi-select, an MCP form or another CLI: the terminal.
 */
export function hookQuestion(detail: HookDetail | null | undefined, cli: QuestionCli): Question {
  const q: HookQuestion | undefined = detail?.question;
  const base: Question = {
    source: "hook",
    kind: "input",
    text: q?.text ?? detail?.message ?? "",
    header: q?.header ?? null,
    tool: detail?.toolName ?? null,
    toolInput: detail?.toolInput ?? null,
    choices: [],
    answerable: false,
  };
  if (!q) return base;
  const claude = cli === "claude";
  if (q.kind === "permission") {
    return {
      ...base,
      kind: "permission",
      text: "",
      choices: [
        { label: "yes", description: null, keys: "1" },
        { label: "no", description: null, keys: ESCAPE },
      ],
      answerable: claude,
    };
  }
  if (q.kind === "choice" && q.options.length > 0) {
    const choices = q.options.slice(0, 9).map((o, i) => ({ label: o.label, description: o.description, keys: String(i + 1) }));
    return { ...base, kind: yesNo(choices.map((c) => c.label)) ? "yes-no" : "choice", choices, answerable: claude && !q.multi && q.count <= 1 };
  }
  return base;
}

function yesNo(labels: readonly string[]): boolean {
  return labels.length === 2 && /^yes\b/i.test(labels[0]!.trim()) && /^no\b/i.test(labels[1]!.trim());
}

/** Markdown emphasis and code marks taken off a line. */
function plain(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const NUMBERED = /^\s*(?:[-*]\s+)?\(?(\d)[.)]\s+(.+)$/;
const LETTERED = /^\s*(?:[-*]\s+)?\(([a-i])\)\s+(.+)$|^\s*(?:[-*]\s+)?([a-i])\)\s+(.+)$/i;
/** A question the agent asks for a yes or a no. */
const YES_NO_ASK = /^(should i|shall i|do you want|would you like|want me to|can i|may i|is it ok(ay)?|okay to|ok to|proceed)\b/i;
const YES_NO_MARK = /\((y\/n|yes\/no)\)|\[(y\/n|yes\/no)\]/i;

/** The last sentence of `line` that ends with a question mark, or null. */
function lastAsk(line: string): string | null {
  const parts = plain(line).match(/[^.!?]*\?/g);
  const ask = parts?.[parts.length - 1]?.trim();
  return ask ? ask : null;
}

/**
 * The question in the text of an agent's turn, or null when it asks none this file can answer:
 *
 * - a list of 2 to 9 options numbered from 1 (`1.`, `1)`) or lettered from a (`a)`, `(a)`), with a line
 *   ending in `?` before or after it: a choice, answered with the number or letter and Enter;
 * - a last line that asks a yes/no question (`Should I…?`, `(y/n)`): yes or no, and Enter.
 *
 * Only the end of the turn counts: a list in the middle of a long answer is not a question.
 */
export function parseQuestionText(text: string): Pick<Question, "kind" | "text" | "choices"> | null {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
  if (lines.length === 0) return null;

  // The last run of option lines, allowing blank lines between options.
  let end = lines.length;
  // One closing line (the question) may follow the list.
  const tail: string[] = [];
  while (end > 0 && tail.length < 1) {
    const line = lines[end - 1]!;
    if (line.trim() === "" || NUMBERED.test(line) || LETTERED.test(line)) break;
    tail.unshift(line);
    end--;
  }
  const options: { mark: string; label: string }[] = [];
  let start = end;
  for (let i = end - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim() === "") {
      if (options.length === 0) {
        start = i;
        continue;
      }
      // A blank line inside the list only when an option comes before it.
      const prev = lines[i - 1];
      if (prev !== undefined && (NUMBERED.test(prev) || LETTERED.test(prev))) continue;
      break;
    }
    const n = NUMBERED.exec(line);
    const l = n ? null : LETTERED.exec(line);
    if (!n && !l) break;
    options.unshift({ mark: n ? n[1]! : (l![1] ?? l![3])!.toLowerCase(), label: plain(n ? n[2]! : (l![2] ?? l![4])!) });
    start = i;
  }
  if (options.length >= 2 && options.length <= 9 && sequential(options.map((o) => o.mark))) {
    const before = lines.slice(0, start).filter((l) => l.trim() !== "");
    const ask = (tail[0] !== undefined ? lastAsk(tail[0]) : null) ?? (before.length > 0 ? lastAsk(before[before.length - 1]!) : null);
    if (ask) {
      return {
        kind: "choice",
        text: ask,
        choices: options.map((o) => ({ label: o.label, description: null, keys: o.mark + ENTER })),
      };
    }
  }

  const last = plain(lines[lines.length - 1]!);
  const ask = lastAsk(last);
  if (ask && (YES_NO_MARK.test(last) || YES_NO_ASK.test(ask))) {
    return {
      kind: "yes-no",
      text: ask.replace(YES_NO_MARK, "").trim(),
      choices: [
        { label: "yes", description: null, keys: "yes" + ENTER },
        { label: "no", description: null, keys: "no" + ENTER },
      ],
    };
  }
  return null;
}

function sequential(marks: readonly string[]): boolean {
  const first = marks[0] === "1" ? "1" : marks[0] === "a" ? "a" : null;
  if (!first) return false;
  return marks.every((m, i) => m === (first === "1" ? String(i + 1) : String.fromCharCode(97 + i)));
}

/**
 * The question of a transcript turn, as a card. Only for a CLI whose prompt takes typed text and
 * Enter; another CLI gets the card with the terminal fallback.
 */
export function transcriptQuestion(text: string, cli: QuestionCli): Question | null {
  const found = parseQuestionText(text);
  if (!found) return null;
  return { source: "transcript", header: null, tool: null, toolInput: null, ...found, answerable: cli === "claude" || cli === "codex" };
}

/** Labels the UI translates: `yes` and `no` are keys, others are shown as the CLI gave them. */
export const TRANSLATED_LABELS = new Set(["yes", "no"]);

/** What a key string looks like to a person: the typed text, and the keys pressed after it. */
export function describeKeys(keys: string): { text: string; enter: boolean; escape: boolean } {
  if (keys === ESCAPE) return { text: "", enter: false, escape: true };
  const enter = keys.endsWith(ENTER);
  return { text: enter ? keys.slice(0, -1) : keys, enter, escape: false };
}
