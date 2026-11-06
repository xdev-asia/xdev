import type { AgentProfile } from "@xdev-asia/ui";
import type { LineAttribution, LineAuthor } from "@/api";
import { chipNames, letterOf, profileOf, when } from "./attributionModel";

/** The class of the library's agent chip; the gutter marker and `AgentChip` share it. */
export const CHIP_CLASS = "ws-chip";
/** The "You" ring of a line changed after the last agent edit. */
export const OUTSIDE_CLASS = "attr-outside";

type T = (key: string, vars?: Record<string, string | number>) => string;

/** Lines as CodeMirror and the backend count them: `\r\n`, `\n` or `\r` end a line; a trailing one leaves an empty last line. */
export function countLines(text: string): number {
  return (text.match(/\r\n|\r|\n/g)?.length ?? 0) + 1;
}

/** The runs fit `text`: same line count, and there is something to show. A stale read shows nothing. */
export function applicable(attr: LineAttribution | null, text: string): attr is LineAttribution {
  return attr !== null && attr.lines > 0 && attr.lines === countLines(text);
}

/** Line number (1-based) → author index. */
export function ownerAt(attr: LineAttribution): Map<number, number> {
  const out = new Map<number, number>();
  for (const r of attr.runs) for (let line = r.from; line <= r.to; line++) out.set(line, r.author);
  return out;
}

export type MarkerSpec = { kind: "agent"; profile: AgentProfile; letter: string | undefined } | { kind: "outside" };

export function markerSpec(author: Pick<LineAuthor, "kind" | "agent">): MarkerSpec {
  if (author.kind === "outside") return { kind: "outside" };
  return { kind: "agent", profile: profileOf(author.agent), letter: letterOf(author.agent) };
}

// The chip's own letters for its named profiles, as `AgentChip` draws them.
const PROFILE_LETTER: Partial<Record<AgentProfile, string>> = { claude: "C", codex: "X" };

/** The letter a marker shows, the same one `AgentChip` would. */
export function chipLetter(spec: Extract<MarkerSpec, { kind: "agent" }>): string {
  return spec.letter ?? PROFILE_LETTER[spec.profile] ?? "A";
}

/** One group per agent tab (two versions of one tab are one group), in author order. */
function groups(attr: LineAttribution): Array<{ key: string; authors: number[] }> {
  const out: Array<{ key: string; authors: number[] }> = [];
  attr.authors.forEach((a, i) => {
    if (a.kind === "outside") return;
    const key = a.tabId ?? `unknown:${a.agent ?? ""}`;
    const found = out.find((g) => g.key === key);
    if (found) found.authors.push(i);
    else out.push({ key, authors: [i] });
  });
  return out;
}

/** The name of each author: the agent, with the tab's last four characters when two tabs share an agent. */
export function authorNames(attr: LineAttribution, unknown: string): string[] {
  const gs = groups(attr);
  const touchers = gs.map((g) => {
    const a = attr.authors[g.authors[0]];
    return { tabId: a.tabId, agent: a.agent, at: a.at ?? 0 };
  });
  const names = chipNames(touchers, unknown);
  const out = attr.authors.map(() => "");
  gs.forEach((g, i) => g.authors.forEach((a) => (out[a] = names[i])));
  return out;
}

/** The hover text of a marker of author `index`. */
export function tooltipOf(attr: LineAttribution, index: number, t: T): string {
  const a = attr.authors[index];
  if (!a || a.kind === "outside") return t("review.attr.gutter.outsideLine");
  const name = authorNames(attr, t("review.attr.unknown"))[index];
  return t("review.attr.gutter.line", { name, time: a.at === null ? "" : when(a.at) });
}

export type LegendEntry = { key: string; spec: MarkerSpec; name: string };

/** The legend of a file: one entry per agent tab, then "You" when a line changed after the agents. Empty with no runs. */
export function legendOf(attr: LineAttribution | null, t: T): LegendEntry[] {
  if (!attr || attr.runs.length === 0) return [];
  const used = new Set(attr.runs.map((r) => r.author));
  const names = authorNames(attr, t("review.attr.unknown"));
  const out: LegendEntry[] = groups(attr)
    .filter((g) => g.authors.some((a) => used.has(a)))
    .map((g) => ({ key: g.key, spec: markerSpec(attr.authors[g.authors[0]]), name: names[g.authors[0]] }));
  const outside = attr.authors.findIndex((a) => a.kind === "outside");
  if (outside >= 0 && used.has(outside)) out.push({ key: "outside", spec: { kind: "outside" }, name: t("review.attr.gutter.outside") });
  return out;
}
