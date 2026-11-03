import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DEMO_SEED } from "@/mockApi";
import { createMockApi, type FileCommands, type QuickCommand } from "@/api";
import { translate } from "@/i18n";
import { QuickCommandDialog } from "@/quickCommands/QuickCommandDialog";
import { resetQuickCommands, startQuickCommands } from "@/quickCommands/store";
import { QuickCommandsPage } from "./QuickCommandsPage";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const items: QuickCommand[] = [
  { id: "g1", label: "Git status", scope: { type: "global" }, action: { type: "terminal", command: "git status", appendEnter: true } },
  { id: "g2", label: "Review", scope: { type: "global" }, action: { type: "agent", profile: "claude", prompt: "Review the diff" } },
];
const file: FileCommands = { trusted: false, hash: "h", errors: [], commands: [{ label: "Lint", action: { type: "terminal", command: "pnpm lint", appendEnter: true } }] };

beforeEach(() => resetQuickCommands());

async function started(list: QuickCommand[]) {
  const api = createMockApi(DEMO_SEED);
  const stub = {
    quickCommandsList: async () => list,
    quickCommandsRecent: async () => [],
    onSettingsChanged: () => () => {},
  };
  startQuickCommands(stub);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  return api;
}

it("lists the saved commands with row actions and the page title", async () => {
  const api = await started(items);
  const html = renderToStaticMarkup(<QuickCommandsPage api={api} onChanged={() => {}} />);
  expect(html).toContain(en("qcmd.title"));
  expect(html).toContain("Git status");
  expect(html).toContain("git status");
  expect(html).toContain(en("qcmd.badge.agent"));
  for (const k of ["edit", "duplicate", "delete"]) expect(html).toContain(en(`qcmd.page.${k}`));
  expect(html).toContain(en("qcmd.page.moveUp"));
});

it("an empty list shows the empty state", async () => {
  const api = await started([]);
  expect(renderToStaticMarkup(<QuickCommandsPage api={api} onChanged={() => {}} />)).toContain(en("qcmd.empty"));
});

it("the first command cannot move up", async () => {
  const api = await started(items);
  const html = renderToStaticMarkup(<QuickCommandsPage api={api} onChanged={() => {}} />);
  const up = html.split("<li").slice(1).map((li) => li.match(/<button[^>]*aria-label="Move up"[^>]*>/)?.[0] ?? "");
  expect(up[0]).toContain("disabled");
  expect(up[1]).not.toContain("disabled");
});

it("the dialog shows Terminal fields first and the limits", () => {
  const html = renderToStaticMarkup(
    <QuickCommandDialog api={createMockApi(DEMO_SEED)} initial={null} defaultRepo="/a" repos={[{ path: "/a", name: "alpha" }]} profiles={[{ id: "claude", name: "Claude" }]} onSaved={() => {}} onCancel={() => {}} />,
  );
  expect(html).toContain(en("qcmd.dialog.newTitle"));
  expect(html).toContain(en("qcmd.dialog.enter"));
  expect(html).toContain(en("qcmd.dialog.scopeRepo"));
  expect(html).toContain("alpha");
  expect(html).not.toContain(en("qcmd.dialog.prompt"));
});

it("editing an agent prompt shows the agent picker and the prompt", () => {
  const html = renderToStaticMarkup(
    <QuickCommandDialog api={createMockApi(DEMO_SEED)} initial={items[1]} defaultRepo={null} repos={[]} profiles={[{ id: "claude", name: "Claude" }]} onSaved={() => {}} onCancel={() => {}} />,
  );
  expect(html).toContain(en("qcmd.dialog.editTitle"));
  expect(html).toContain("Review the diff");
  expect(html).toContain("Claude");
});

it("every new qcmd key exists in vi too", async () => {
  const vi_ = (await import("@/i18n/vi.json")).default as Record<string, string>;
  const en_ = (await import("@/i18n/en.json")).default as Record<string, string>;
  for (const k of Object.keys(en_).filter((k) => k.startsWith("qcmd."))) expect(vi_, k).toHaveProperty([k]);
  void file;
});
