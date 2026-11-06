import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TargetsView } from "@/api";
import { I18nProvider } from "@/i18n";
import { RunTargetsItems } from "./RunTargetsMenu";

const view = (over: Partial<TargetsView> = {}): TargetsView => ({
  deploy: [
    { name: "Vercel preview", run: "vercel deploy", confirm: false, source: "detected" },
    { name: "Staging", run: "make stage", confirm: false, source: "repo" },
  ],
  vps: { host: "prod-1", cwd: null, notes: null },
  trusted: true,
  hash: "h",
  text: "x",
  error: null,
  vpsHostKnown: true,
  ...over,
});

const draw = (v: TargetsView | null) =>
  renderToStaticMarkup(
    <I18nProvider>
      <RunTargetsItems view={v} onDeploy={vi.fn()} onServer={vi.fn()} onReview={vi.fn()} />
    </I18nProvider>,
  );

it("shows nothing but the title while loading", () => {
  const html = draw(null);
  expect(html).toContain("Run targets");
  expect(html).not.toContain("menuitem");
});

it("groups Deploy and Server, with presets as menu items", () => {
  const html = draw(view());
  expect(html).toContain("Vercel preview");
  expect(html).toContain("Staging");
  expect(html).toContain("Open server shell");
  expect(html).not.toContain("Review and trust");
  expect(html).not.toContain("disabled");
});

it("disables repo presets and the server shell while untrusted, and offers review", () => {
  const html = draw(view({ trusted: false }));
  expect(html).toContain("Review and trust");
  expect(html.match(/disabled/g)?.length).toBe(2);
});

it("says so when nothing is found", () => {
  expect(draw(view({ deploy: [], vps: null, hash: "" }))).toContain("No deploy targets found");
});

it("warns when the vps host is not known", () => {
  expect(draw(view({ vpsHostKnown: false }))).toContain("prod-1 is not in your SSH hosts");
});
