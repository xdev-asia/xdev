import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createMockApi, type DocEntry, type StaleDoc } from "../api";
import { I18nProvider } from "../i18n";
import { DEMO_COMMITS, DEMO_SEED } from "../mockApi";
import { Sidebar } from "./Sidebar";

function render(docs: DocEntry[], stale?: StaleDoc[]): string {
  return renderToStaticMarkup(
    <I18nProvider>
      <Sidebar docs={docs} activePath={null} stale={stale} onOpen={() => {}} />
    </I18nProvider>,
  );
}

describe("Sidebar", () => {
  it("sidebar_marks_stale_docs", async () => {
    const api = createMockApi(DEMO_SEED, { commits: DEMO_COMMITS });
    const docs = await api.openVault("/vault");
    const html = render(docs, await api.staleDocs());
    const marks = html.match(/<span class="docitem-stale"[^>]*>[^<]*<\/span>/g) ?? [];
    expect(marks).toEqual([
      '<span class="docitem-stale" data-state="stale" title="3 new commits since it was verified">stale</span>',
      '<span class="docitem-stale" data-state="unverified" title="Not verified yet">unverified</span>',
    ]);
    // The mark sits in the doc's own button, next to its title.
    expect(html).toMatch(/<span class="docitem-title">Store design<\/span><span class="docitem-stale"/);
  });

  it("shows no mark without stale docs", async () => {
    const api = createMockApi(DEMO_SEED, { commits: DEMO_COMMITS });
    const docs = await api.openVault("/vault");
    expect(render(docs)).not.toContain("docitem-stale");
    expect(render(docs, [])).not.toContain("docitem-stale");
  });
});
