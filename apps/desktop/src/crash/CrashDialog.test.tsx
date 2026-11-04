import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { CrashReport } from "@/api";
import en from "@/i18n/en.json";
import { translate } from "@/i18n";
import { CrashDialog, crashTitleKey } from "./CrashDialog";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const report = (source: "main" | "renderer"): CrashReport => ({
  id: "r1",
  createdAt: 0,
  status: "pending",
  source,
  process: "app",
  reason: "panic",
  exitCode: null,
  appVersion: "1",
  platform: "p",
  arch: "a",
  details: [{ key: "message", value: "kaboom" }],
  breadcrumbs: [],
});

describe("CrashDialog", () => {
  it("has three titles", () => {
    expect(en[crashTitleKey(report("main")) as keyof typeof en]).toBe("xDev closed unexpectedly");
    expect(en[crashTitleKey(report("renderer")) as keyof typeof en]).toBe("xDev hit a recoverable UI error");
    expect(en[crashTitleKey(null) as keyof typeof en]).toBe("No crash report");
  });

  it("shows the text in a code block with one primary button", () => {
    const html = renderToStaticMarkup(<CrashDialog open={false} report={report("main")} onClose={() => {}} />);
    expect(html).toContain("kaboom");
    expect(html).toContain("connect-code");
    expect(html).toContain(en["crash.notes.label"]);
    expect(html.match(/class="btn"/g)).toHaveLength(1);
    expect(html).toContain(en["crash.copy"]);
    expect(html).toContain(en["crash.close"]);
    expect(html).toContain(en["crash.body"]);
  });

  it("says no report was captured and still offers the app details", () => {
    const html = renderToStaticMarkup(<CrashDialog open={false} report={null} onClose={() => {}} />);
    expect(html).toContain(en["crash.title.none"]);
    expect(html).toContain(en["crash.body.none"]);
    expect(html).toContain("captured_crash_report: false");
  });
});
