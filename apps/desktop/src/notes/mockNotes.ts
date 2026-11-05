import type { Api, ApiError, ContextUsage, Note } from "@/api";

type NotesApi = Pick<Api, "agentContextUsage" | "notesList" | "notesGet" | "notesPut" | "notesDelete">;

export type MockPaneChrome = NotesApi & {
  // Sets what `agentContextUsage` answers for an agent session id; `null` makes it unknown again.
  __contextUsage(session: string, usage: ContextUsage | null): void;
};

/** The most bytes of a note body, as in Rust. */
export const NOTE_BODY_MAX = 64 * 1024;

const reject = (code: ApiError["code"], detail?: string): Promise<never> => {
  const error: ApiError = detail === undefined ? { code } : { code, detail };
  return Promise.reject(error);
};

/** The notes store and the context read of the demo, with the checks of the Rust ones. */
export function createMockPaneChrome(now: () => number = () => Date.now()): MockPaneChrome {
  const notes = new Map<string, Note>();
  const usage = new Map<string, ContextUsage>();
  let last = 0;
  return {
    async agentContextUsage(session) {
      const found = usage.get(session);
      return found ? { ...found } : null;
    },
    async notesList() {
      return [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((n) => ({ ...n }));
    },
    async notesGet(tab) {
      const found = notes.get(tab);
      return found ? { ...found } : null;
    },
    async notesPut(note) {
      if (!note.tab || /[\u0000-\u001f\u007f]/.test(note.tab) || note.tab.length > 128) return reject("bad_note", "bad tab");
      if (new TextEncoder().encode(note.body).length > NOTE_BODY_MAX) return reject("bad_note", "note is longer than 64 KB");
      if (note.body.trim() === "") {
        notes.delete(note.tab);
        return null;
      }
      // Strictly rising, so two saves in one millisecond still sort.
      last = Math.max(now(), last + 1);
      const saved = { ...note, updatedAt: last };
      notes.set(note.tab, saved);
      return { ...saved };
    },
    async notesDelete(tab) {
      notes.delete(tab);
    },
    __contextUsage(session, next) {
      if (next) usage.set(session, { ...next });
      else usage.delete(session);
    },
  };
}
