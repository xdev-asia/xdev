import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { TabStrip, type StripItem } from "./TabStrip";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);
const noop = () => undefined;

function html(items: StripItem[]): string {
  return renderToStaticMarkup(
    <TabStrip
      pane="p1"
      items={items}
      active={null}
      groups={[]}
      menuOpen={false}
      onMenu={noop}
      onSelect={noop}
      onClose={noop}
      onCloseOthers={noop}
      onCloseToRight={noop}
      onLaunch={noop}
      onSplit={noop}
      onMoveToSplit={noop}
      onPin={noop}
      onCopyTabId={noop}
      onRename={noop}
      onChangeTitle={noop}
      onColor={noop}
    />,
  );
}

const file = (gone?: "deleted" | "renamed"): StripItem => ({ id: "file:src/a.ts", tab: null, file: { rel: "src/a.ts", dirty: false, ...(gone ? { gone } : {}) } });

it("a file tab shows its file name", () => {
  const out = html([file()]);
  expect(out).toContain(">a.ts<");
  expect(out).not.toContain("ws-tab-gone");
  expect(out).not.toContain(en("review.tab"));
});

it("a deleted or renamed file tab carries the mark and its label", () => {
  for (const gone of ["deleted", "renamed"] as const) {
    const out = html([file(gone)]);
    expect(out).toContain("ws-tab ws-tab-gone");
    expect(out).toContain(`>${en(`files.tab.${gone}`)}<`);
  }
});

it("the review tab keeps its own label", () => {
  expect(html([{ id: "review", tab: null }])).toContain(en("review.tab"));
});
