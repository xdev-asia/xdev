import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Note } from "@/api";
import { translate } from "@/i18n";
import { createMockPaneChrome } from "./mockNotes";
import { NoteEditor } from "./NoteEditor";
import { NoteRow, NotesLibrary } from "./NotesLibrary";
import { createNotesStore } from "./notesStore";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const note = (tab: string, body: string, over: Partial<Note> = {}): Note => ({ tab, worktree: "/w/oak", title: "Claude", body, updatedAt: Date.UTC(2026, 10, 5, 12, 0), ...over });
const target = { tab: "t1", worktree: "/w/oak", title: "Claude" };

it("the editor has one primary button (Save) and the secondary ones for send, delete and the library", () => {
  const store = createNotesStore(createMockPaneChrome());
  const html = renderToStaticMarkup(
    <NoteEditor store={store} target={target} note={note("t1", "# Plan\n- one")} onClose={() => {}} onSend={async () => {}} onLibrary={() => {}} />,
  );
  expect(html).toContain("Note for Claude");
  expect(html).toContain("Send to agent");
  expect(html).toContain("Delete note");
  expect(html).toContain("All notes…");
  expect(html.match(/class="btn"/g)).toHaveLength(1);
  expect(html).toContain("<h1>Plan</h1>");
  expect(html).toContain('aria-label="Preview"');
  expect(html).toContain("of 64 KB");
});

it("a new note has no Delete, and Send is disabled while it is blank or absent", () => {
  const store = createNotesStore(createMockPaneChrome());
  const html = renderToStaticMarkup(<NoteEditor store={store} target={target} note={null} onClose={() => {}} onSend={async () => {}} />);
  expect(html).not.toContain("Delete note");
  expect(html).not.toContain("All notes…");
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Send to agent/);
  expect(html).not.toContain("Preview");
  const closed = renderToStaticMarkup(<NoteEditor store={store} target={target} note={null} onClose={() => {}} />);
  expect(closed).not.toContain("Send to agent");
});

it("a note over 64 KB shows the error and disables Save", () => {
  const store = createNotesStore(createMockPaneChrome());
  const html = renderToStaticMarkup(<NoteEditor store={store} target={target} note={note("t1", "a".repeat(65_537))} onClose={() => {}} />);
  expect(html).toContain("A note holds at most 64 KB");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toMatch(/<button[^>]*disabled[^>]*>Save/);
});

it("the library lists tab, worktree and date, marks a closed tab, and disables Send for it", () => {
  const html = renderToStaticMarkup(
    <NotesLibrary
      notes={[note("t1", "fix the parser"), note("t2", "write docs", { title: "Codex", worktree: "/w/elm" })]}
      liveTabs={new Set(["t1"])}
      onEdit={() => {}}
      onSend={() => {}}
      onDelete={() => {}}
      onClose={() => {}}
    />,
  );
  expect(html).toContain('aria-label="Search notes"');
  expect(html).toContain("Claude");
  expect(html).toContain("/w/oak");
  expect(html).toContain("Nov 5, 2026");
  expect(html).toContain("Its tab is closed");
  expect(html).toContain('aria-label="Send note for Claude to agent"');
  expect(html).toMatch(/<button[^>]*aria-label="Send note for Codex to agent"[^>]*disabled|<button[^>]*disabled[^>]*aria-label="Send note for Codex to agent"/);
  expect(html.match(/class="btn"/g)).toHaveLength(1);
});

it("an empty library says how to start", () => {
  const html = renderToStaticMarkup(<NotesLibrary notes={[]} liveTabs={new Set()} onEdit={() => {}} onSend={() => {}} onDelete={() => {}} onClose={() => {}} />);
  expect(html).toContain("No notes yet.");
});

it("the library buttons act on their note", () => {
  const calls: string[] = [];
  const el = NoteRow({ note: note("t1", "x"), live: true, when: () => "", onEdit: (n) => calls.push(`edit:${n.tab}`), onSend: (n) => calls.push(`send:${n.tab}`), onDelete: (n) => calls.push(`delete:${n.tab}`) });
  const found: ReactElement<Record<string, any>>[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object" && "props" in v) {
      found.push(v as ReactElement<Record<string, any>>);
      walk((v as ReactElement<Record<string, any>>).props.children);
    }
  };
  walk(el);
  for (const label of ["Edit note for Claude", "Send note for Claude to agent", "Delete note for Claude"]) {
    found.find((e) => (e.props["aria-label"] ?? e.props.label) === label)!.props.onClick();
  }
  expect(calls).toEqual(["edit:t1", "send:t1", "delete:t1"]);
});
