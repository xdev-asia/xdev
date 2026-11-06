import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { JSX } from "react";
import { I18nProvider } from "@/i18n";
import type { AttributionEvent } from "@/api";
import { createMockApi } from "@/api";
import { AgentChips } from "./AgentChips";
import { LivePanel } from "./LivePanel";
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
