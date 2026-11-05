import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import type { PaneChipsViewProps } from "./PaneChips";
import { PaneChipsView } from "./PaneChips";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const base = (over: Partial<PaneChipsViewProps> = {}): PaneChipsViewProps => ({
  agent: true,
  prefs: { quota: true, context: true, timer: true },
  quota: { account: "claude-2", fiveHour: 12, weekly: 40 },
  usage: { tokens: 45_005, window: 200_000, model: "claude-sonnet-5-5" },
  clock: { since: Date.now() - 65_000, endedAt: null },
  narrow: false,
  hasNote: false,
  onNote: () => {},
  open: false,
  onOpen: () => {},
  said: "",
  ...over,
});
const html = (over?: Partial<PaneChipsViewProps>) => renderToStaticMarkup(PaneChipsView(base(over)));

it("shows the three chips, each with an accessible name", () => {
  const out = html();
  expect(out).toContain('aria-label="Quota used by claude-2: 5-hour 12%, weekly 40%"');
  expect(out).toContain('aria-label="Context window: 45,005 of 200,000 tokens used (23%)"');
  expect(out).toMatch(/aria-label="Agent working for 1:0\d"/);
  expect(out).toContain('data-chip="quota"');
  expect(out).toContain('data-chip="context"');
  expect(out).toContain('data-chip="timer"');
  // Each chip has a tooltip with the same words.
  expect(out.match(/role="tooltip"/g)).toHaveLength(3);
});

it("an unknown context is hidden, not zero; so is a quota that could not be read", () => {
  const out = html({ usage: null, quota: null });
  expect(out).not.toContain('data-chip="context"');
  expect(out).not.toContain('data-chip="quota"');
  expect(out).not.toContain("Ctx 0%");
});

it("a chip turned off is not drawn", () => {
  const out = html({ prefs: { quota: false, context: true, timer: false } });
  expect(out).not.toContain('data-chip="quota"');
  expect(out).not.toContain('data-chip="timer"');
  expect(out).toContain('data-chip="context"');
});

it("a stopped timer says it is the last run; a shell has none", () => {
  const now = Date.now();
  expect(html({ clock: { since: now - 90_000, endedAt: now } })).toContain('aria-label="Last run took 1:30"');
  expect(html({ agent: false })).not.toContain('data-chip="timer"');
  expect(html({ clock: undefined })).not.toContain('data-chip="timer"');
});

it("a full context or quota turns to a warning", () => {
  expect(html({ usage: { tokens: 170_000, window: 200_000, model: null } })).toContain('data-chip="context" data-warn=""');
  expect(html({ quota: { account: "a", fiveHour: 91, weekly: null } })).toContain('data-chip="quota" data-warn=""');
});

it("the note button is named, and says when the note has text", () => {
  expect(html()).toContain('aria-label="Sticky note"');
  const filled = html({ hasNote: true });
  expect(filled).toContain('aria-label="Sticky note, has text"');
  expect(filled).toContain("pane-note-dot");
});

it("narrow, the chips fold behind one button and the note button stays", () => {
  const out = html({ narrow: true });
  expect(out).toContain('aria-label="Pane details"');
  expect(out).not.toContain('data-chip="quota"');
  expect(out).toContain('aria-label="Sticky note"');
  const open = html({ narrow: true, open: true });
  expect(open).toContain('role="dialog"');
  expect(open).toContain('data-chip="timer"');
});

it("the status region carries the end of a run", () => {
  expect(html({ said: "Run finished after 1:30" })).toContain('role="status">Run finished after 1:30<');
});
