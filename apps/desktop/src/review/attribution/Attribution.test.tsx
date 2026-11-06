import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JSX } from "react";
import { AgentChip } from "@xdev-asia/ui";
import { I18nProvider } from "@/i18n";
import type { AttributionEvent } from "@/api";
import { createMockApi } from "@/api";
import { AgentChips } from "./AgentChips";
import { LineLegend } from "./LineLegend";
import { LivePanel } from "./LivePanel";
import { CHIP_CLASS } from "./lineGutterModel";
import { RestoreConfirm, VersionsDialog } from "./VersionsDialog";

const render = (node: JSX.Element): string => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const OAK = "/demo/wt/xdev-oak";

it("agent chips name each tab that touched the file", () => {
  const html = render(
    <AgentChips
      touchers={[
        { tabId: "t1", agent: "claude", at: 2 },
        { tabId: "t2", agent: "codex", at: 1 },
      ]}
    />,
  );
  expect(html).toContain('aria-label="Changed by"');
  expect(html).toContain(">C<");
  expect(html).toContain(">X<");
  expect(html).toContain('<span class="attr-chip-name">claude</span>');
  expect(html).toContain('<span class="attr-chip-name">codex</span>');
});

it("compact chips leave the names out; an unknown writer reads Unknown", () => {
  const compact = render(<AgentChips compact touchers={[{ tabId: "t1", agent: "claude", at: 1 }]} />);
  expect(compact).not.toContain("attr-chip-name");
  const unknown = render(<AgentChips touchers={[{ tabId: null, agent: null, at: 1 }]} />);
  expect(unknown).toContain(">Unknown<");
  expect(render(<AgentChips touchers={[]} />)).toBe("");
});

it("the live panel lists the latest changes and says the newest one in a status", () => {
  const events: AttributionEvent[] = [
    { worktree: OAK, path: "src/b.ts", tabId: "t2", agent: "codex", at: 2000, source: "hook" },
    { worktree: OAK, path: "src/a.ts", tabId: "t1", agent: "claude", at: 1000, source: "single" },
  ];
  const html = render(<LivePanel events={events} onOpen={() => {}} />);
  expect(html).toContain('role="status"');
  expect(html).toContain("codex changed src/b.ts");
  expect(html.indexOf("src/b.ts")).toBeLessThan(html.indexOf("src/a.ts", html.indexOf("<ul")));
  expect(render(<LivePanel events={[]} onOpen={() => {}} />)).toContain("No agent changes seen yet.");
});

it("the restore question is an alert dialog that names the file and has Cancel and the verb", () => {
  const html = render(<RestoreConfirm path="src/a.ts" time="10:00" onConfirm={() => {}} onCancel={() => {}} />);
  expect(html).toContain('role="alertdialog"');
  expect(html).toContain("Restore this version of src/a.ts?");
  expect(html).toContain("Cancel");
  expect(html).toContain("Restore version");
});

it("the versions dialog opens loading, with a Close button and no restore", () => {
  const html = render(<VersionsDialog api={createMockApi({})} worktree={OAK} path="src/a.ts" onClose={() => {}} onRestored={() => {}} />);
  expect(html).toContain("Versions of src/a.ts");
  expect(html).toContain("Close");
  expect(html).not.toContain(">Restore<");
});

it("the mock keeps versions once per content, twenty at most, and restores one", async () => {
  const api = createMockApi({});
  const mock = api as unknown as { __attributionTouch(w: string, p: string, who: { tabId: string; agent: string } | null, c: string): Promise<void> };
  const who = { tabId: "t1", agent: "claude" };
  await mock.__attributionTouch(OAK, "src/a.ts", who, "one");
  await mock.__attributionTouch(OAK, "src/a.ts", who, "two");
  await mock.__attributionTouch(OAK, "src/a.ts", who, "one");
  const list = await api.attributionVersions(OAK, "src/a.ts");
  expect(list).toHaveLength(2);
  for (let i = 0; i < 25; i++) await mock.__attributionTouch(OAK, "src/a.ts", who, `v${i}`);
  const full = await api.attributionVersions(OAK, "src/a.ts");
  expect(full).toHaveLength(20);
  const oldest = full[full.length - 1];
  await api.attributionRestore(OAK, "src/a.ts", oldest.id);
  expect((await api.fileRead(OAK, "src/a.ts")).text).toBe(await api.attributionVersionRead(OAK, "src/a.ts", oldest.id));
});

it("the gutter marker uses the chip's own class and profile attribute", () => {
  const html = renderToStaticMarkup(<AgentChip profile="claude" title="claude" />);
  expect(html).toContain(`class="${CHIP_CLASS}"`);
  expect(html).toContain('data-profile="claude"');
  // A custom agent's chip has no profile attribute; the marker leaves it out too.
  expect(renderToStaticMarkup(<AgentChip profile="custom" letter="A" title="aider" />)).not.toContain("data-profile");
});

it("the line legend names each agent tab with its chip, then You; nothing without marked lines", () => {
  const attr = {
    lines: 4,
    authors: [
      { kind: "agent" as const, tabId: "t1", agent: "claude", at: 1 },
      { kind: "agent" as const, tabId: "t2", agent: "aider", at: 2 },
      { kind: "outside" as const, tabId: null, agent: null, at: null },
    ],
    runs: [
      { from: 1, to: 1, author: 0 },
      { from: 2, to: 2, author: 1 },
      { from: 4, to: 4, author: 2 },
    ],
  };
  const html = render(<LineLegend attr={attr} />);
  expect(html).toContain('<p class="attr-legend"><span>Line authors</span>');
  expect(html.match(/class="ws-chip"/g)).toHaveLength(2);
  expect(html).toContain('data-profile="claude"');
  expect(html).toContain(">A</span>");
  expect(html).toContain('<span class="attr-chip-name">aider</span>');
  expect(html).toContain('class="attr-outside"');
  expect(html).toContain('<span class="attr-chip-name">You</span>');
  expect(render(<LineLegend attr={{ ...attr, runs: [] }} />)).toBe("");
  expect(render(<LineLegend attr={null} />)).toBe("");
});
