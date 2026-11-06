// When to ask "Start language servers for this repo?": only after the person opened several files of one language here.
import { lspLanguageId } from "./languageIds";

/** Distinct files of one language, in one repo, that make a server worth asking about. */
export const ASK_AFTER_FILES = 3;

const KEY = "xdev.lsp.seen";

export interface AskStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStore(): AskStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Remembers which files of each language were opened per repo (a worktree path), so the count survives restarts. */
export class LspAskCounter {
  private seen: Record<string, string[]> | null = null;

  constructor(private readonly store: AskStore | null = browserStore()) {}

  private load(): Record<string, string[]> {
    if (this.seen) return this.seen;
    let out: Record<string, string[]> = {};
    try {
      const raw = this.store?.getItem(KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [k, v] of Object.entries(parsed)) if (Array.isArray(v)) out[k] = v.filter((x): x is string => typeof x === "string");
      }
    } catch {
      out = {};
    }
    this.seen = out;
    return out;
  }

  /** Notes that `rel` was opened in `worktree`; returns the number of distinct files of its language seen there. 0 for a file no server handles. */
  note(worktree: string, rel: string): number {
    const language = lspLanguageId(rel);
    if (language === null) return 0;
    const all = this.load();
    const slot = `${worktree}\0${language}`;
    const files = all[slot] ?? [];
    if (!files.includes(rel)) {
      files.push(rel);
      all[slot] = files;
      try {
        this.store?.setItem(KEY, JSON.stringify(all));
      } catch {
        // The count stays in memory.
      }
    }
    return files.length;
  }

  /** True when enough files of the language were opened to ask. */
  shouldAsk(worktree: string, rel: string): boolean {
    return this.note(worktree, rel) >= ASK_AFTER_FILES;
  }
}

export const lspAsk = new LspAskCounter();
