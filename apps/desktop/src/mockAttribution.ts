import type { Api, ApiError, AttributionChanged, AttributionEvent, FileAttribution, FileVersion, LineAttribution } from "./api";

type AttributionApi = Pick<Api, "attributionFiles" | "attributionRecent" | "attributionVersions" | "attributionVersionRead" | "attributionRestore" | "attributionLines" | "onAttributionChanged">;

export type MockAttribution = AttributionApi & {
  /** Plays an agent tab writing `content` to `path`: logs it, keeps a version and writes the file. `who` null is an unknown writer. */
  __attributionTouch(worktree: string, path: string, who: { tabId: string; agent: string } | null, content: string): Promise<void>;
};

// The same bounds as the backend.
const MAX_EVENTS = 5000;
const MAX_VERSIONS = 20;
const MAX_BYTES = 1_000_000;

function hashOf(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619) >>> 0;
  return `${h.toString(16).padStart(8, "0")}${text.length.toString(16).padStart(8, "0")}`;
}

/** Attribution in memory. `write` puts a file's text on the mock disk; `read` reads it (null when it is not there). */
export function createMockAttribution(disk: { write(worktree: string, rel: string, text: string): void; read(worktree: string, rel: string): Promise<string | null> }): MockAttribution {
  const events = new Map<string, AttributionEvent[]>();
  const versions = new Map<string, Array<FileVersion & { text: string }>>();
  const listeners = new Set<(e: AttributionChanged) => void>();
  let clock = Date.parse("2026-01-01T10:00:00Z");
  const reject = (code: ApiError["code"], detail: string): Promise<never> => Promise.reject({ code, detail } satisfies ApiError);
  const keep = (worktree: string, path: string, version: FileVersion & { text: string }): void => {
    const key = `${worktree}\0${path}`;
    const list = (versions.get(key) ?? []).filter((v) => v.id !== version.id);
    list.push(version);
    while (list.length > MAX_VERSIONS) list.shift();
    versions.set(key, list);
  };
  return {
    async attributionFiles(worktree) {
      const out = new Map<string, FileAttribution>();
      for (const e of events.get(worktree) ?? []) {
        const file = out.get(e.path) ?? { path: e.path, touchedBy: [] };
        const mine = file.touchedBy.find((t) => t.tabId === e.tabId);
        if (mine) mine.at = Math.max(mine.at, e.at);
        else file.touchedBy.push({ tabId: e.tabId, agent: e.agent, at: e.at });
        out.set(e.path, file);
      }
      return [...out.values()].map((f) => ({ ...f, touchedBy: [...f.touchedBy].sort((a, b) => b.at - a.at) }));
    },
    async attributionRecent(worktree, limit) {
      return [...(events.get(worktree) ?? [])].reverse().slice(0, Math.min(limit, 200));
    },
    async attributionVersions(worktree, path) {
      return [...(versions.get(`${worktree}\0${path}`) ?? [])].reverse().map(({ text: _text, ...v }) => v);
    },
    async attributionVersionRead(worktree, path, id) {
      const found = versions.get(`${worktree}\0${path}`)?.find((v) => v.id === id);
      return found ? found.text : reject("not_found", path);
    },
    async attributionRestore(worktree, path, id) {
      const found = versions.get(`${worktree}\0${path}`)?.find((v) => v.id === id);
      if (!found) return reject("not_found", path);
      disk.write(worktree, path, found.text);
    },
    // The preview shows no line authors: lines with no data show nothing.
    async attributionLines(): Promise<LineAttribution> {
      return { lines: 0, authors: [], runs: [] };
    },
    async onAttributionChanged(cb) {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    },
    async __attributionTouch(worktree, path, who, content) {
      clock += 1000;
      const log = events.get(worktree) ?? [];
      log.push({ worktree, path, tabId: who?.tabId ?? null, agent: who?.agent ?? null, at: clock, source: who ? "hook" : "unknown" });
      while (log.length > MAX_EVENTS) log.shift();
      events.set(worktree, log);
      disk.write(worktree, path, content);
      if (who && content.length <= MAX_BYTES) keep(worktree, path, { id: hashOf(content), at: clock, size: content.length, tabId: who.tabId, agent: who.agent, text: content });
      for (const cb of [...listeners]) cb({ worktree });
    },
  };
}
