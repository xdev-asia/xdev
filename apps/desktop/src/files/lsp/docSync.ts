import { toApiError, type Api } from "@/api";
import { fileTabs, type FileEntry, type FileTabs } from "../fileTabs";
import { lspLanguageId } from "./languageIds";
import { lspStatus, type LspStatusStore } from "./lspStatus";

/** How long the text must stay still before a change goes to the server. */
export const CHANGE_DELAY_MS = 200;

type SyncApi = Pick<Api, "lspOpen" | "lspChange" | "lspClose">;

interface Doc {
  worktree: string;
  rel: string;
  languageId: string;
  /** The version the server last got. */
  version: number;
  /** The text the server last got (or is getting). */
  sent: string;
  /** Opened, or being opened; false after a refusal, until `retry`. */
  active: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  // Calls to the server for this document run one after another.
  queue: Promise<void>;
}

const key = (worktree: string, rel: string) => `${worktree}\0${rel}`;

/** Keeps the language servers' copy of every open text file the same as the editor's. */
export class DocSync {
  private readonly docs = new Map<string, Doc>();
  private readonly off: () => void;

  constructor(
    private readonly api: SyncApi,
    private readonly store: FileTabs = fileTabs,
    private readonly status: LspStatusStore = lspStatus,
    private readonly delay = CHANGE_DELAY_MS,
  ) {
    this.off = store.subscribe(() => this.sync());
    this.sync();
  }

  dispose(): void {
    this.off();
    for (const doc of this.docs.values()) if (doc.timer) clearTimeout(doc.timer);
    this.docs.clear();
  }

  /** Opens the documents of `worktree` again (after Start or Restart). */
  retry(worktree: string): void {
    for (const doc of [...this.docs.values()]) {
      if (doc.worktree !== worktree) continue;
      if (doc.timer) clearTimeout(doc.timer);
      doc.timer = null;
      this.status.setDoc(worktree, doc.rel, null);
      const entry = this.store.get(worktree, doc.rel);
      if (!entry) continue;
      doc.version = 0;
      this.open(doc, entry.text);
    }
    this.sync();
  }

  private sync(): void {
    const live = new Set<string>();
    for (const entry of this.store.all()) {
      const languageId = lspLanguageId(entry.rel);
      if (!isSyncable(entry) || languageId === null) continue;
      const k = key(entry.worktree, entry.rel);
      live.add(k);
      const doc = this.docs.get(k);
      if (!doc) {
        const created: Doc = { worktree: entry.worktree, rel: entry.rel, languageId, version: 0, sent: entry.text, active: false, timer: null, queue: Promise.resolve() };
        this.docs.set(k, created);
        this.open(created, entry.text);
      } else if (doc.active && entry.text !== doc.sent) {
        this.schedule(doc);
      }
    }
    for (const [k, doc] of [...this.docs]) {
      if (live.has(k)) continue;
      this.docs.delete(k);
      this.status.setDoc(doc.worktree, doc.rel, null);
      if (doc.timer) clearTimeout(doc.timer);
      doc.timer = null;
      doc.queue = doc.queue.then(() => (doc.active ? this.api.lspClose(doc.worktree, doc.rel).catch(() => undefined) : undefined));
    }
  }

  private open(doc: Doc, text: string): void {
    doc.active = true;
    doc.sent = text;
    doc.version = 1;
    doc.queue = doc.queue.then(async () => {
      try {
        const out = await this.api.lspOpen(doc.worktree, doc.rel, doc.languageId, 1, text);
        if (this.docs.get(key(doc.worktree, doc.rel)) !== doc) return;
        this.status.setDoc(doc.worktree, doc.rel, out.language === null || out.state === "notFound" ? "off" : "ready");
      } catch (e) {
        doc.active = false;
        if (this.docs.get(key(doc.worktree, doc.rel)) !== doc) return;
        const err = toApiError(e);
        if (err.code === "lsp_untrusted") {
          this.status.setDoc(doc.worktree, doc.rel, "untrusted");
          // A "no" given this session is not asked again.
          if (err.detail !== "session") this.status.setAsking(doc.worktree, true);
        } else {
          this.status.setDoc(doc.worktree, doc.rel, "off");
        }
      }
    });
  }

  private schedule(doc: Doc): void {
    if (doc.timer) clearTimeout(doc.timer);
    doc.timer = setTimeout(() => {
      doc.timer = null;
      const entry = this.store.get(doc.worktree, doc.rel);
      if (!entry || !doc.active || entry.text === doc.sent) return;
      const text = entry.text;
      const version = ++doc.version;
      doc.sent = text;
      doc.queue = doc.queue.then(async () => {
        if (!doc.active) return;
        try {
          await this.api.lspChange(doc.worktree, doc.rel, version, text);
        } catch {
          // The next edit sends the whole text again.
        }
      });
    }, this.delay);
  }
}

function isSyncable(e: FileEntry): boolean {
  return e.status === "ready" && e.kind === "text";
}
