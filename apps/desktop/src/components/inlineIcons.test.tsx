import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Freshness } from "@/api";
import { I18nProvider } from "@/i18n";
import { NavButtons } from "@/nav/NavButtons";
import { QuickCommandsButton } from "@/quickCommands/QuickCommandsButton";
import { HeaderSearch } from "@/workspace/HeaderSearch";
import { Toasts } from "@/workspace/Toasts";
import { pushToast, resetToastsForTests } from "@/workspace/toastStore";
import { ActivityBar } from "./ActivityBar";
import { ICON, Icon } from "./ChangesPanel";
import { FreshnessBanner } from "./FreshnessBanner";
import { VaultEmpty } from "./NoVaultView";

vi.mock("@/keys/bindingsStore", async (original) => ({ ...await original<typeof import("@/keys/bindingsStore")>(), useBindings: () => ({}) }));

// The shared Icon draws every one of these; what matters here is that each file reaches it with the old path data.
const render = (node: JSX.Element): string => renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
const svgs = (html: string): string[] => html.match(/<svg [^>]*>/g) ?? [];
const decorative = (tag: string): void => {
  expect(tag).toContain('class="x-icon');
  expect(tag).toContain('aria-hidden="true"');
  expect(tag).toContain('viewBox="0 0 24 24"');
};

afterEach(resetToastsForTests);

describe("shared icons in the shell", () => {
  it("activity bar draws one 22 px icon per app", () => {
    const html = render(<ActivityBar active="docs" changeCount={null} onSelect={() => {}} />);
    expect(svgs(html)).toHaveLength(8);
    for (const tag of svgs(html)) {
      decorative(tag);
      expect(tag).toContain('width="22"');
    }
    expect(html).toContain('d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"');
    expect(html).toContain('d="m7 9 3 3-3 3M13 15h4"');
  });

  it("nav buttons draw the two chevrons", () => {
    const html = render(<NavButtons canBack canForward onBack={() => {}} onForward={() => {}} />);
    expect(svgs(html)).toHaveLength(2);
    expect(html).toContain('d="M15 6l-6 6 6 6"');
    expect(html).toContain('d="M9 6l6 6-6 6"');
  });

  it("header search draws a 13 px magnifier", () => {
    const html = render(<HeaderSearch onOpen={() => {}} />);
    decorative(svgs(html)[0]!);
    expect(html).toContain('width="13"');
    expect(html).toContain('d="m20 20-3.5-3.5"');
  });

  it("command button draws the prompt", () => {
    const html = render(<QuickCommandsButton open={false} onOpen={() => {}} />);
    decorative(svgs(html)[0]!);
    expect(html).toContain('d="m5 8 5 4-5 4M12 17h7"');
  });

  it("toast close draws a 12 px cross with a 2 px stroke", () => {
    pushToast({ id: "t", text: "Saved" });
    const html = render(<Toasts />);
    decorative(svgs(html)[0]!);
    expect(html).toContain('width="12"');
    expect(html).toContain("stroke-width:2");
    expect(html).toContain('d="M6 6l12 12M18 6 6 18"');
  });

  it("empty vault draws folder and plus", () => {
    const html = render(<VaultEmpty busy={false} onCreate={() => {}} onOpen={() => {}} />);
    expect(html).toContain('class="x-icon vault-empty-icon"');
    expect(html).toContain('d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"');
    expect(html).toContain('d="M12 5v14M5 12h14"');
  });

  it("freshness banner draws the alert", () => {
    const stale: Freshness = { state: "stale", covers: [], verified: "3f2a9c1", head: "d2096ce", commits: [], count: 1 };
    const html = render(<FreshnessBanner freshness={stale} draft="" now={1_800_000_000} disabled={false} onMarkVerified={() => {}} />);
    expect(html).toContain('class="x-icon banner-icon"');
    expect(html).toContain('d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"');
  });

  it("the changes panel Icon maps every ICON entry to a registered name", () => {
    for (const name of Object.values(ICON)) {
      const html = renderToStaticMarkup(<Icon d={name} size={18} />);
      decorative(svgs(html)[0]!);
      expect(html, name).toContain('width="18"');
    }
  });

  it("none of the migrated files draws an svg by hand", () => {
    const files = [
      "components/ActivityBar.tsx",
      "nav/NavButtons.tsx",
      "workspace/Toasts.tsx",
      "workspace/HeaderSearch.tsx",
      "quickCommands/QuickCommandsButton.tsx",
      "workspace/FileTree.tsx",
      "components/NoVaultView.tsx",
      "components/FreshnessBanner.tsx",
      "components/ChangesPanel.tsx",
    ];
    for (const file of files) expect(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"), file).not.toContain("<svg");
  });
});
