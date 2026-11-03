import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "../api";
import { translate } from "../i18n";
import { MemoryTree } from "../kit/MemoryTab";
import { PromptChecks } from "../kit/PromptsTab";
import { SkillTable } from "../kit/SkillsTab";
import { UsageChart } from "../kit/UsageChart";
import { checkPrompt } from "../kit/promptCheck";
import { WorkspaceFooter } from "../workspace/WorkspaceFooter";
import { AgentKitView } from "./AgentKitView";

vi.mock("../i18n", async (original) => ({
  ...(await original<typeof import("../i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const noop = () => {};

it("renders four tabs and opens initialTab", () => {
  const api = createMockApi({});
  const html = renderToStaticMarkup(<AgentKitView api={api} worktree={null} initialTab="memory" />);
  const tabs = [...html.matchAll(/<button[^>]*role="tab"[^>]*>/g)].map((m) => m[0]);
  expect(tabs).toHaveLength(4);
  for (const name of ["skills", "memory", "prompts", "usage"]) expect(html).toContain(en(`kit.tab.${name}`));
  // Exactly one tab is selected: the one asked for.
  expect(tabs.filter((tab) => tab.includes('aria-selected="true"'))).toHaveLength(1);
  expect(tabs.find((tab) => tab.includes('aria-selected="true"'))).toContain('data-tab="memory"');
  // Skills is the default.
  const first = renderToStaticMarkup(<AgentKitView api={api} worktree={null} />);
  expect(first.match(/<button[^>]*role="tab"[^>]*aria-selected="true"[^>]*>/)?.[0]).toContain('data-tab="skills"');
});

it("skills duplicate row shows dot", async () => {
  const api = createMockApi({});
  const [skills, homes] = await Promise.all([api.kitSkills(null), api.kitHomes()]);
  const html = renderToStaticMarkup(<SkillTable skills={skills} homes={homes} onOpen={noop} onCopy={noop} onRemove={noop} />);
  const rows = html.split("<tr").slice(1).filter((r) => r.includes('data-skill="'));
  expect(rows).toHaveLength(skills.length);
  const duplicates = rows.filter((r) => r.includes('data-dot="duplicate"'));
  // "review" lives in both homes; the other two are unique.
  expect(duplicates).toHaveLength(2);
  expect(duplicates.every((r) => r.includes('data-skill="review"'))).toBe(true);
  expect(html).toContain(en("kit.skills.duplicate"));
});

it("memory shows load total", async () => {
  const api = createMockApi({});
  const [set, homes] = await Promise.all([api.kitMemory(null), api.kitHomes()]);
  expect(set.load_tokens).toBeGreaterThan(0);
  const html = renderToStaticMarkup(<MemoryTree set={set} homes={homes} selected={null} onSelect={noop} />);
  expect(html).toContain(en("kit.memory.load", { count: set.load_tokens }));
  // Each file shows its own tokens, and a file with an issue gets a dot.
  for (const file of set.files) expect(html).toContain(en("kit.tokens", { count: file.tokens }));
  expect(html).toContain('data-dot="issue"');
});

it("prompts shows score for typed text", () => {
  const text = "Add a retry to the fetch helper so a failed request is tried three times. Done when the retry test passes.";
  const expected = checkPrompt(text, {});
  expect(expected.score).toBeGreaterThan(0);
  const html = renderToStaticMarkup(<PromptChecks text={text} existing={{}} />);
  expect(html).toContain(en("kit.prompt.score", { score: expected.score }));
  expect(html).toContain(en("kit.tokens", { count: expected.tokens }));
  for (const check of expected.checks) expect(html).toContain(`data-check="${check.id}"`);
  // A failing check shows its hint; a passing one does not.
  const vague = renderToStaticMarkup(<PromptChecks text="fix it" existing={{}} />);
  expect(vague).toContain(en("kit.prompt.hint.accept"));
  expect(html).not.toContain(en("kit.prompt.hint.goal"));
});

it("usage renders one bar per day", async () => {
  const api = createMockApi({});
  const usage = await api.kitUsage("2026-10-28", "2026-11-03", false);
  expect(usage.days).toHaveLength(7);
  const html = renderToStaticMarkup(<UsageChart days={usage.days} />);
  expect(html.match(/data-day="/g)).toHaveLength(7);
  // Each bar stacks input, output and cache.
  for (const part of ["input", "output", "cache"]) expect(html.match(new RegExp(`data-part="${part}"`, "g"))).toHaveLength(7);
  expect(html).toContain("<svg");
});

it("footer popover has token usage link", () => {
  const html = renderToStaticMarkup(
    WorkspaceFooter({ branch: "main", running: 0, waiting: 0, quota: null, version: "0.3.0", onOpenUsage: noop }),
  );
  expect(html).toMatch(/<button[^>]*data-action="token-usage"[^>]*>/);
  expect(html).toContain(en("kit.usage.link"));
  // Without a handler the footer shows no link.
  const bare = renderToStaticMarkup(WorkspaceFooter({ branch: "main", running: 0, waiting: 0, quota: null, version: "0.3.0" }));
  expect(bare).not.toContain("token-usage");
});

/** The declarations that draw a stripe down one side of a box: a left or inline-start border, or an inset or sideways box-shadow. */
function stripes(css: string): string[] {
  const found: string[] = [];
  for (const [, prop, value] of css.matchAll(/([a-z-]+)\s*:\s*([^;}]+)/g)) {
    if (/^border-(left|inline-start)/.test(prop!)) found.push(`${prop}: ${value}`);
    if (prop === "box-shadow") {
      for (const shadow of value!.split(/,(?![^(]*\))/)) {
        if (/\binset\b/.test(shadow) || /^\s*-/.test(shadow)) found.push(`box-shadow: ${shadow.trim()}`);
      }
    }
  }
  return found;
}

it("the stripe check catches each way of drawing one", () => {
  expect(stripes(".a { border-left: 3px solid red; }")).toHaveLength(1);
  expect(stripes(".a { border-left-color: red; }")).toHaveLength(1);
  expect(stripes(".a { border-inline-start: 3px solid red; }")).toHaveLength(1);
  expect(stripes(".a { border-inline-start-width: 3px; }")).toHaveLength(1);
  expect(stripes(".a { box-shadow: inset 3px 0 0 red; }")).toHaveLength(1);
  expect(stripes(".a { box-shadow: inset 3px 0 0 0 red; }")).toHaveLength(1);
  expect(stripes(".a { box-shadow: -3px 0 0 red; }")).toHaveLength(1);
  expect(stripes(".a { box-shadow: 0 1px 2px rgb(0 0 0 / 0.2), -4px 0 0 red; }")).toHaveLength(1);
  expect(stripes(".a { border: 1px solid red; border-bottom: 2px solid red; box-shadow: 0 1px 2px red; }")).toHaveLength(0);
});

it("no kit rule draws a stripe down a side", () => {
  const file = "../styles/kit.css";
  expect(stripes(readFileSync(new URL(file, import.meta.url), "utf8")), file).toEqual([]);
});
