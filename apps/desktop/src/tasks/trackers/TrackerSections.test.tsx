import { IconButton, ListRow, StatusDot, Switch } from "@xdev-asia/ui";
import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type Api, type ApiError } from "@/api";
import { translate } from "@/i18n";
import { mount, nodes, type Node } from "@/kit/testHooks";
import { TrackerSection, TrackerSections, type SectionProps } from "./TrackerSections";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const rejection = (code: string, detail?: string): ApiError => ({ code, detail }) as ApiError;
const noop = () => undefined;

function section(api: Api, patch: Partial<SectionProps> = {}) {
  const props: SectionProps = {
    api,
    repoId: "r",
    source: "linear",
    pulls: { assigned: true, created: false, done: false },
    pullsKey: "k",
    shown: true,
    onShown: noop,
    onStart: noop,
    ...patch,
  };
  const view = mount(TrackerSection as (p: SectionProps) => ReactElement, () => props);
  const html = () => renderToStaticMarkup(view.draw() as never);
  return { view, html, props };
}

it("draws GitHub then Linear, and no Jira header, when only Linear is connected", async () => {
  const api = createMockApi({});
  const view = mount(TrackerSections, () => ({ api, repo: { id: "r", path: "/r" }, agents: [], current: null, onStart: async () => null, view: {} }));
  const all = await view.settle();
  const order = all.filter((n) => n.type === TrackerSection).map((n) => n.props.source);
  expect(order).toEqual(["github", "linear"]);
});

it("a Linear section has a labelled switch and refresh, a count and its rows", async () => {
  const api = createMockApi({});
  const { view, html } = section(api);
  const all = await view.settle();
  expect(all.find((n) => n.type === Switch)?.props.label).toBe("Show Linear");
  expect(all.find((n) => n.type === IconButton)?.props.label).toBe("Refresh Linear");
  const out = html();
  expect(out).toContain("ENG-12");
  expect(out).toContain("In Progress");
  expect(out).toContain("Unassigned");
  expect(out).toContain('aria-label="3 issues"');
  expect(out).not.toContain("btn-primary");
  const rows = (await view.settle()).filter((n) => n.type === ListRow);
  const dots = rows.map((r) => nodes(r.props.leading).find((n) => n.type === StatusDot)?.props.tone);
  expect(dots).toEqual(["accent", "ok", "neutral"]);
});

it("Open calls openUrl once; Start hands the row up", async () => {
  const api = createMockApi({});
  const open = vi.spyOn(api, "openUrl").mockResolvedValue();
  const started: string[] = [];
  const { view } = section(api, { onStart: (row) => void started.push(row.key) });
  const rows = (await view.settle()).filter((n) => n.type === ListRow);
  const buttons = nodes(rows[0].props.trailing).filter((n) => n.type === IconButton);
  expect(buttons.map((b) => b.props.label)).toEqual(["Open ENG-12 in browser", "Start agent on ENG-12"]);
  (buttons[0].props.onClick as () => void)();
  (buttons[1].props.onClick as () => void)();
  expect(open).toHaveBeenCalledTimes(1);
  expect(open).toHaveBeenCalledWith("https://linear.app/example/issue/ENG-12");
  expect(started).toEqual(["ENG-12"]);
});

it("a hidden section keeps its header and asks for nothing", async () => {
  const api = createMockApi({});
  const list = vi.spyOn(api, "trackerList");
  const { view, html } = section(api, { shown: false });
  const all: Node[] = await view.settle();
  expect(list).not.toHaveBeenCalled();
  expect(all.find((n) => n.type === Switch)?.props.checked).toBe(false);
  expect(html()).not.toContain("ENG-12");
});

it("a refused key shows the auth text and Retry", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "trackerList").mockRejectedValue(rejection("tracker_auth"));
  const { view, html } = section(api);
  await view.settle();
  expect(html()).toContain(translate("en", "error.tracker_auth"));
  expect(html()).toContain("Retry");
});

it("a rate limit with a wait names the seconds", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "trackerList").mockRejectedValue(rejection("tracker_rate_limited", "60"));
  const { view, html } = section(api);
  await view.settle();
  expect(html()).toContain("Try again in 60 s");
});

it("a cut list says it showed the first 200", async () => {
  const api = createMockApi({});
  const real = await api.trackerList("linear");
  vi.spyOn(api, "trackerList").mockResolvedValue({ ...real, truncated: true });
  const { view, html } = section(api);
  await view.settle();
  expect(html()).toContain("Showing the first 200");
});

it("GitHub: not_github hides the section, gh_auth gives its reason line", async () => {
  const hidden = createMockApi({});
  vi.spyOn(hidden, "issuesList").mockRejectedValue(rejection("not_github"));
  const a = section(hidden, { source: "github" });
  await a.view.settle();
  expect(a.html()).toBe("");

  const signedOut = createMockApi({});
  vi.spyOn(signedOut, "issuesList").mockRejectedValue(rejection("gh_auth"));
  const b = section(signedOut, { source: "github" });
  await b.view.settle();
  expect(b.html()).toContain(translate("en", "issues.reason.gh_auth"));
});

it("GitHub rows come from the issues list and read Open", async () => {
  const api = createMockApi({});
  const { view, html } = section(api, { source: "github" });
  await view.settle();
  expect(html()).toContain("GitHub issues");
  expect(html()).toMatch(/#\d+/);
  expect(html()).toContain("Open");
});
