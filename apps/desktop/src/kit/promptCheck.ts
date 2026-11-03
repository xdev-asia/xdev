export type CheckId = "goal" | "accept" | "files" | "single" | "vague" | "length";

export interface Check {
  id: CheckId;
  pass: boolean;
  weight: number;
  hintKey: string;
}

/** Action verbs that open a goal (en + vi). Matched with and without diacritics. */
export const GOAL_VERBS = [
  "add", "fix", "write", "remove", "rename", "make", "create", "update", "change", "delete", "build", "move",
  "implement", "refactor", "show", "replace", "support", "handle", "test", "document", "rewrite", "extract",
  "split", "merge", "return", "render", "display", "validate", "convert",
  "thêm", "sửa", "viết", "xoá", "xóa", "đổi", "làm", "tạo", "cập nhật", "chuyển",
  "hiển thị", "thay", "triển khai", "viết lại", "tách", "gộp", "kiểm tra", "hỗ trợ", "xử lý", "đưa",
];

/** Words that, alone, do not name an object. */
const FILLER = [
  "it", "this", "that", "them", "these", "those", "a", "an", "the", "better", "to", "up",
  "nó", "này", "đó", "kia", "cho", "tốt", "hơn",
];

/** Words or phrases that show how to verify the work. Single words match as a prefix. */
export const ACCEPT_WORDS = ["test", "expected", "kiểm tra", "kết quả"];

/** Phrases that state when the work is done. */
export const DONE_PHRASES = ["done when", "xong khi"];

/** Phrases that name no object by themselves. */
export const VAGUE_PHRASES = [
  "fix it", "make it better", "improve it", "clean it up", "sửa nó", "làm cho tốt hơn", "làm nó tốt hơn",
];

/** Joiners that tack a second task onto the first. */
export const JOINERS = ["and also", "và cả"];

const WEIGHTS: Record<CheckId, number> = { goal: 25, accept: 25, files: 15, single: 15, vague: 10, length: 10 };
const ORDER: CheckId[] = ["goal", "accept", "files", "single", "vague", "length"];
const MIN_WORDS = 15;
const MAX_WORDS = 1500;

/** NFC + lower-case, then strip diacritics so "thêm" and "them" read the same. */
function fold(s: string): string {
  return s
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d");
}

const words = (list: string[]) => list.map((p) => fold(p).split(" "));
const GOAL_SET = new Set(GOAL_VERBS.map(fold));
const FILLER_SET = new Set(FILLER.map(fold));

function sentences(text: string): string[][] {
  return fold(text)
    .split(/[.!?]+(?:\s+|$)|\n+/)
    .map((s) => s.match(/[\p{L}\p{N}_][\p{L}\p{N}_'./\\-]*/gu) ?? [])
    .filter((t) => t.length > 0);
}

/** Index of the first run of `phrase` words inside `tokens`, or -1. */
function seq(tokens: string[], phrase: string[]): number {
  for (let i = 0; i + phrase.length <= tokens.length; i++) {
    if (phrase.every((w, j) => tokens[i + j] === w)) return i;
  }
  return -1;
}

const hasObject = (rest: string[]) => rest.some((w) => !FILLER_SET.has(w));

const PATH_RE = /^[\w.@~-]+(?:[\\/][\w.@~-]+)*\.[A-Za-z][A-Za-z0-9]{0,7}$/;
const trimEdge = (s: string) => s.replace(/^[("'[]+/, "").replace(/[.,;:!?)"'\]]+$/, "");

/** Backticked or slash-containing tokens that end in a file extension. Exact strings, each once. */
export function namedPaths(text: string): string[] {
  const out: string[] = [];
  const add = (raw: string, needSlash: boolean) => {
    const t = trimEdge(raw.trim());
    if (!PATH_RE.test(t)) return;
    if (needSlash && !/[\\/]/.test(t)) return;
    if (!out.includes(t)) out.push(t);
  };
  const found: { at: number; t: string; ticked: boolean }[] = [];
  for (const m of text.matchAll(/`([^`\n]+)`/g)) found.push({ at: m.index ?? 0, t: m[1], ticked: true });
  const bare = text.replace(/`[^`\n]*`/g, (s) => " ".repeat(s.length));
  for (const m of bare.matchAll(/\S+/g)) found.push({ at: m.index ?? 0, t: m[0], ticked: false });
  found.sort((a, b) => a.at - b.at);
  for (const f of found) add(f.t, !f.ticked);
  return out;
}

function checkGoal(sents: string[][]): boolean {
  return sents.some((tokens) => tokens.some((w, i) => GOAL_SET.has(w) && hasObject(tokens.slice(i + 1))));
}

function checkAccept(text: string, sents: string[][]): boolean {
  if (/`[^`\n]+`/.test(text)) return true;
  const phrases = words([...ACCEPT_WORDS, ...DONE_PHRASES]);
  return sents.some((tokens) =>
    phrases.some((p) =>
      p.length === 1 ? tokens.some((w) => w.startsWith(p[0])) : seq(tokens, p) >= 0,
    ),
  );
}

function numberedLists(text: string): number {
  let lists = 0;
  let inList = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\d+[.)]\s+\S/.test(line)) {
      if (!inList) lists++;
      inList = true;
    } else if (line.trim() !== "" && !/^\s+/.test(line)) {
      // A non-indented, non-numbered line ends the list. Blank and indented lines continue it.
      inList = false;
    }
  }
  return lists;
}

function checkSingle(text: string, sents: string[][]): boolean {
  if (numberedLists(text) > 1) return false;
  const joiners = words(JOINERS);
  return !sents.some((tokens) =>
    joiners.some((j) => {
      const at = seq(tokens, j);
      return at >= 0 && GOAL_SET.has(tokens[at + j.length] ?? "");
    }),
  );
}

function checkVague(sents: string[][]): boolean {
  const phrases = words(VAGUE_PHRASES);
  return !sents.some((tokens) =>
    phrases.some((p) => {
      const at = seq(tokens, p);
      return at >= 0 && !hasObject(tokens.slice(at + p.length));
    }),
  );
}

export function checkPrompt(
  text: string,
  existing: Record<string, boolean>,
): { tokens: number; checks: Check[]; score: number } {
  const sents = sentences(text);
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const results: Record<CheckId, boolean> = {
    goal: checkGoal(sents),
    accept: checkAccept(text, sents),
    files: namedPaths(text).every((p) => existing[p] === true),
    single: checkSingle(text, sents),
    vague: checkVague(sents),
    length: wordCount >= MIN_WORDS && wordCount <= MAX_WORDS,
  };
  const checks: Check[] = ORDER.map((id) => ({
    id,
    pass: results[id],
    weight: WEIGHTS[id],
    hintKey: `kit.prompt.hint.${id}`,
  }));
  return {
    tokens: Math.ceil(new TextEncoder().encode(text).length / 4),
    checks,
    score: checks.reduce((n, c) => n + (c.pass ? c.weight : 0), 0),
  };
}
