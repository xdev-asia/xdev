// What `@` and `/` list in the composer: open tabs (inserts the tab's worktree path), templates
// (inserted at the cursor, or kept to be added on send), files of the worktree and, for `/`, skills.

import type { PromptTemplate } from "@/api";
import { insertCompletion, rankMatches, type Token } from "@/agentLaunch/completion";

export type MentionTab = { id: string; label: string; worktree: string };
export type Mention =
  | { kind: "tab"; key: string; label: string; worktree: string }
  | { kind: "template"; key: string; label: string; template: PromptTemplate }
  | { kind: "file"; key: string; label: string }
  | { kind: "skill"; key: string; label: string; description: string };

/** How many tabs and templates a list shows before the files. */
export const MAX_TABS = 8;
export const MAX_TEMPLATES = 8;

function pick<T>(items: readonly T[], label: (t: T) => string, query: string, max: number): T[] {
  const byLabel = new Map<string, T>();
  for (const t of items) if (!byLabel.has(label(t))) byLabel.set(label(t), t);
  return rankMatches([...byLabel.keys()], query, max).map((l) => byLabel.get(l)!);
}

/** The rows of the list for `token`: tabs, then templates, then files for `@`; skills for `/`. */
export function mentionsFor(
  token: Token,
  lists: {
    tabs: readonly MentionTab[];
    templates: readonly PromptTemplate[];
    files: readonly string[] | null;
    skills: readonly { name: string; description: string }[] | null;
  },
): Mention[] {
  const q = token.query;
  if (token.trigger === "/") {
    return pick(lists.skills ?? [], (s) => s.name, q, 50).map((s) => ({ kind: "skill", key: `s:${s.name}`, label: s.name, description: s.description }));
  }
  return [
    ...pick(lists.tabs, (t) => t.label, q, MAX_TABS).map((t): Mention => ({ kind: "tab", key: `t:${t.id}`, label: t.label, worktree: t.worktree })),
    ...pick(lists.templates, (t) => t.name, q, MAX_TEMPLATES).map((t): Mention => ({ kind: "template", key: `p:${t.id}`, label: t.name, template: t })),
    ...rankMatches(lists.files ?? [], q).map((f): Mention => ({ kind: "file", key: `f:${f}`, label: f })),
  ];
}

/**
 * `text` after picking `m` in place of `token`, the cursor after the insert, and the template to add
 * on send (an append template leaves the text without its token).
 */
export function applyMention(text: string, token: Token, m: Mention): { text: string; cursor: number; append: PromptTemplate | null } {
  const replace = (insert: string) => {
    const after = text.slice(token.end);
    return { text: text.slice(0, token.start) + insert + after, cursor: token.start + insert.length, append: null };
  };
  switch (m.kind) {
    case "file":
    case "skill":
      return { ...insertCompletion(text, token, m.label), append: null };
    case "tab":
      return replace(`${m.worktree} `);
    case "template":
      if (m.template.mode === "append") {
        const after = text.slice(token.end).replace(/^ /, "");
        return { text: text.slice(0, token.start) + after, cursor: token.start, append: m.template };
      }
      return replace(m.template.body);
  }
}

/** The prompt as sent: the text, then the bodies of the append templates, a blank line apart. */
export function finalPrompt(text: string, append: readonly PromptTemplate[]): string {
  const parts = [text.trimEnd(), ...append.map((t) => t.body.trim())].filter((p) => p !== "");
  return parts.join("\n\n");
}

/** A new template id: letters, digits and `-`. */
export function newTemplateId(now = Date.now(), rand = Math.random()): string {
  return `t-${now.toString(36)}-${Math.floor(rand * 36 ** 4).toString(36)}`;
}
