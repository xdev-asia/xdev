// The frontmatter subset from the M1b spec. Same rules as `xdev-vault`; both run `fixtures/frontmatter.json`.

export type Target = "agents" | "claude" | "gemini" | "cursor";
export const TARGETS: readonly Target[] = ["agents", "claude", "gemini", "cursor"];
export type Frontmatter = { title: string | null; agents: Target[]; tags: string[] };

const BOM = "﻿";
const KEY_LINE = /^([A-Za-z_][\w-]*):(?:[ \t]+(.*))?$/;
const ITEM_LINE = /^[ \t]*-[ \t]+(.*)$/;

type Value = { kind: "text"; text: string; quoted: boolean } | { kind: "list"; items: string[] };

// A line keeps its own ending, so edits can put back exactly what was there.
type Line = { text: string; eol: string };

type Split = {
  bom: string;
  lines: Line[];
  // Index of the closing `---` line; -1 when the text has no frontmatter.
  close: number;
};

function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  for (const match of text.matchAll(/([^\n]*?)(\r?\n|$)/g)) {
    if (match[0] === "" && match.index === text.length) break;
    lines.push({ text: match[1], eol: match[2] });
  }
  return lines;
}

function split(content: string): Split {
  const bom = content.startsWith(BOM) ? BOM : "";
  const lines = splitLines(content.slice(bom.length));
  let close = -1;
  if (lines.length > 0 && lines[0].text === "---" && lines[0].eol !== "") {
    close = lines.findIndex((line, i) => i > 0 && line.text === "---");
  }
  return { bom, lines, close };
}

function join(lines: Line[]): string {
  return lines.map((l) => l.text + l.eol).join("");
}

function unquote(s: string): string | null {
  if (s.length >= 2 && (s[0] === '"' || s[0] === "'") && s.endsWith(s[0])) return s.slice(1, -1);
  return null;
}

// YAML comments need whitespace before `#`, so `a#b` stays one value.
function cutComment(s: string): string {
  const at = s.search(/[ \t]#/);
  return (at === -1 ? s : s.slice(0, at)).trim();
}

function scalar(raw: string): { text: string; quoted: boolean } {
  const trimmed = raw.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const end = trimmed.indexOf(quote, 1);
    if (end !== -1) return { text: trimmed.slice(1, end), quoted: true };
  }
  return { text: cutComment(trimmed), quoted: false };
}

function parseValue(raw: string): Value {
  const { text, quoted } = scalar(raw);
  if (!quoted && text.startsWith("[") && text.endsWith("]")) {
    const items = text
      .slice(1, -1)
      .split(",")
      .map((item) => {
        const trimmed = item.trim();
        return unquote(trimmed) ?? trimmed;
      })
      .filter((item) => item !== "");
    return { kind: "list", items };
  }
  return { kind: "text", text, quoted };
}

// Key → value; a key with an empty value collects the `- item` lines below it.
function readBlock(lines: Line[]): Map<string, Value> {
  const values = new Map<string, Value>();
  let listKey: string | null = null;
  for (const { text } of lines) {
    const key = KEY_LINE.exec(text);
    if (key) {
      const raw = key[2] ?? "";
      if (cutComment(raw) === "") {
        listKey = key[1];
        values.set(listKey, { kind: "list", items: [] });
      } else {
        listKey = null;
        values.set(key[1], parseValue(raw));
      }
      continue;
    }
    const item = ITEM_LINE.exec(text);
    const list = listKey === null ? undefined : values.get(listKey);
    if (item && list?.kind === "list") {
      const value = scalar(item[1]).text;
      if (value !== "") list.items.push(value);
    }
  }
  return values;
}

function toList(value: Value | undefined): string[] {
  if (value === undefined) return [];
  if (value.kind === "list") return value.items;
  return value.text === "" ? [] : [value.text];
}

function toAgents(value: Value | undefined): Target[] {
  if (value?.kind === "text" && !value.quoted) {
    if (value.text === "true") return ["agents"];
    if (value.text === "false") return [];
  }
  const names = new Set(toList(value));
  return TARGETS.filter((target) => names.has(target));
}

function toTitle(value: Value | undefined): string | null {
  if (value?.kind !== "text") return null;
  const title = value.text.trim();
  return title === "" ? null : title;
}

export function parseFrontmatter(content: string): { fm: Frontmatter; body: string; raw: string | null } {
  const { lines, close } = split(content);
  const body = content.startsWith(BOM) ? content.slice(BOM.length) : content;
  if (close === -1) return { fm: { title: null, agents: [], tags: [] }, body, raw: null };
  const inner = lines.slice(1, close);
  const values = readBlock(inner);
  return {
    fm: { title: toTitle(values.get("title")), agents: toAgents(values.get("agents")), tags: toList(values.get("tags")) },
    body: join(lines.slice(close + 1)),
    raw: join(inner),
  };
}

/** `` ` `` or `~` when the line opens or closes a fenced code block. */
export function fenceMarker(line: string): string | null {
  const match = /^(`{3,}|~{3,})/.exec(line.trimStart());
  return match ? match[1][0] : null;
}

// Calls `visit` for each line outside fenced code; `visit` returns true to stop.
export function eachProseLine(text: string, visit: (line: string) => boolean | void): void {
  let fence: string | null = null;
  for (const { text: line } of splitLines(text)) {
    const marker = fenceMarker(line);
    if (marker !== null && (fence === null || fence === marker)) {
      fence = fence === null ? marker : null;
      continue;
    }
    if (fence === null && visit(line)) return;
  }
}

function stem(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
}

export function extractTitle(path: string, content: string): string {
  const { fm, body } = parseFrontmatter(content);
  if (fm.title !== null) return fm.title;
  let heading: string | null = null;
  // `# ` inside a code block is usually a shell comment, not a title.
  eachProseLine(body, (line) => {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("# ")) return false;
    const title = trimmed.slice(2).trim();
    if (title !== "") heading = title;
    return heading !== null;
  });
  return heading ?? stem(path);
}

function agentsLine(lines: Line[], close: number): number {
  for (let i = 1; i < close; i++) if (KEY_LINE.exec(lines[i].text)?.[1] === "agents") return i;
  return -1;
}

// Only a missing key or a plain `true` / `false` maps onto one checkbox; a list of names does not.
export function agentsEditable(content: string): boolean {
  const { lines, close } = split(content);
  if (close === -1) return true;
  const at = agentsLine(lines, close);
  if (at === -1) return true;
  const value = parseValue(KEY_LINE.exec(lines[at].text)?.[2] ?? "");
  return value.kind === "text" && !value.quoted && (value.text === "true" || value.text === "false");
}

export function setAgents(content: string, on: boolean): string {
  if (!agentsEditable(content)) return content;
  const { bom, lines, close } = split(content);
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  if (close === -1) {
    return on ? `${bom}---${eol}agents: true${eol}---${eol}${content.slice(bom.length)}` : content;
  }
  const at = agentsLine(lines, close);
  const next = [...lines];
  if (on) {
    if (at !== -1 && parseFrontmatter(content).fm.agents.length > 0) return content;
    const line = { text: "agents: true", eol: at === -1 ? eol : lines[at].eol };
    if (at === -1) next.splice(close, 0, line);
    else next[at] = line;
    return bom + join(next);
  }
  if (at === -1 || parseFrontmatter(content).fm.agents.length === 0) return content;
  next.splice(at, 1);
  const empty = next.slice(1, close - 1).every((line) => line.text.trim() === "");
  return bom + join(empty ? next.slice(close) : next);
}
