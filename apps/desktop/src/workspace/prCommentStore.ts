import { toApiError, type Api, type ApiError, type PrComment, type PrCommentDraft, type Reaction } from "@/api";

export type CommentEntry = {
  number: number;
  comments: PrComment[];
  /** A source held 100 or more comments; the rest is not shown. */
  truncated: boolean;
  /** The last read or action failed. The comments stay as they were. */
  error?: ApiError;
};

/**
 * The review comments of each worktree's PR, read through the api. One read per path runs at a time;
 * whoever asks while it runs gets the same promise. A read that was overtaken by a newer write is
 * dropped. Resolving and reacting show at once and roll back when GitHub refuses.
 */
export class PrCommentStore {
  private entries = new Map<string, CommentEntry>();
  private running = new Map<string, { number: number; promise: Promise<void> }>();
  private generation = new Map<string, number>();
  private listeners = new Set<() => void>();
  private version = 0;

  constructor(private readonly api: Api) {}

  get(path: string): CommentEntry | undefined {
    return this.entries.get(path);
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }

  snapshot = (): number => this.version;

  load(path: string, number: number): Promise<void> {
    const again = this.running.get(path);
    if (again && again.number === number) return again.promise;
    const entry = { number, promise: Promise.resolve() };
    entry.promise = this.read(path, number).finally(() => {
      if (this.running.get(path) === entry) this.running.delete(path);
    });
    this.running.set(path, entry);
    return entry.promise;
  }

  /** Posts a comment, a reply or an inline comment, then reads again. Rejects when the post fails. */
  async post(path: string, number: number, draft: PrCommentDraft): Promise<void> {
    await this.api.worktreePrCommentPost(path, number, draft);
    await this.load(path, number);
  }

  /** Resolves or reopens a thread at once. Returns false, with the error kept, when it failed. */
  async resolve(path: string, threadId: string, resolved: boolean): Promise<boolean> {
    const before = this.entries.get(path);
    if (!before) return false;
    this.write(path, { ...before, comments: before.comments.map((c) => (c.threadId === threadId ? { ...c, resolved } : c)), error: undefined });
    try {
      await this.api.worktreePrThreadResolve(path, threadId, resolved);
      return true;
    } catch (e) {
      this.rollback(path, (c) => (c.threadId === threadId ? before.comments.find((b) => b.id === c.id) ?? c : c), toApiError(e));
      return false;
    }
  }

  /** Adds or removes the signed-in person's reaction at once. Returns false when it failed. */
  async react(path: string, nodeId: string, content: Reaction, on: boolean): Promise<boolean> {
    const before = this.entries.get(path);
    if (!before) return false;
    const old = before.comments.find((c) => c.nodeId === nodeId);
    if (!old) return false;
    this.write(path, { ...before, comments: before.comments.map((c) => (c.nodeId === nodeId ? { ...c, reactions: toggled(c, content, on) } : c)), error: undefined });
    try {
      await this.api.worktreePrReaction(path, nodeId, content, on);
      return true;
    } catch (e) {
      this.rollback(path, (c) => (c.nodeId === nodeId ? { ...c, reactions: old.reactions } : c), toApiError(e));
      return false;
    }
  }

  private async read(path: string, number: number): Promise<void> {
    const gen = this.generation.get(path) ?? 0;
    const before = this.entries.get(path);
    try {
      const got = await this.api.worktreePrComments(path, number);
      if ((this.generation.get(path) ?? 0) !== gen) return;
      this.entries.set(path, { number, comments: got.comments, truncated: got.truncated });
    } catch (e) {
      if ((this.generation.get(path) ?? 0) !== gen) return;
      this.entries.set(path, { number, comments: before?.number === number ? before.comments : [], truncated: before?.truncated ?? false, error: toApiError(e) });
    }
    this.bump();
  }

  /** A write bumps the generation, so a read that started earlier cannot overwrite it. */
  private write(path: string, entry: CommentEntry): void {
    this.generation.set(path, (this.generation.get(path) ?? 0) + 1);
    this.entries.set(path, entry);
    this.bump();
  }

  /** Puts one change back on the current comments, so a later change is kept. */
  private rollback(path: string, undo: (c: PrComment) => PrComment, error: ApiError): void {
    const now = this.entries.get(path);
    if (!now) return;
    this.write(path, { ...now, comments: now.comments.map(undo), error });
  }

  private bump(): void {
    this.version += 1;
    for (const fn of [...this.listeners]) fn();
  }
}

function toggled(c: PrComment, content: Reaction, on: boolean): PrComment["reactions"] {
  const found = c.reactions.find((r) => r.content === content);
  if (!found) return on ? [...c.reactions, { content, count: 1, mine: true }] : c.reactions;
  if (found.mine === on) return c.reactions;
  const count = found.count + (on ? 1 : -1);
  const next = c.reactions.map((r) => (r === found ? { ...r, count, mine: on } : r));
  return next.filter((r) => r.count > 0);
}
