import { describe, expect, it } from "vitest";
import type { CrashReport } from "@/api";
import { crashCopyText, crashSummary, MAX_COPY, TRUNCATED } from "./copyText";

const report: CrashReport = {
  id: "r1",
  createdAt: Date.UTC(2026, 10, 4, 1, 2, 3),
  status: "pending",
  source: "main",
  process: "app",
  reason: "panic",
  exitCode: null,
  appVersion: "1.2.3",
  platform: "windows",
  arch: "x86_64",
  details: [
    { key: "location", value: "src/a.rs:1:2" },
    { key: "message", value: "boom" },
  ],
  breadcrumbs: [
    { at: Date.UTC(2026, 10, 4, 1, 2, 0), name: "renderer_error", data: [{ key: "message", value: "x" }, { key: "n", value: "1" }] },
    { at: Date.UTC(2026, 10, 4, 1, 2, 1), name: "tick", data: [] },
  ],
};

describe("crash copy text", () => {
  it("lists the fields in order, then details and recent activity", () => {
    expect(crashCopyText({ report, webview: "UA" })).toBe(
      [
        "[Crash Report]",
        [
          "Report ID: r1",
          "Created: 2026-11-04T01:02:03.000Z",
          "Status: pending",
          "Source: main",
          "Process: app",
          "Reason: panic",
          "Exit code: none",
          "App version: 1.2.3",
          "Platform: windows x86_64",
          "WebView: UA",
        ].join("\n"),
        "Details:\n- location: src/a.rs:1:2\n- message: boom",
        "Recent activity:\n- 2026-11-04T01:02:00.000Z: renderer_error (message=x, n=1)\n- 2026-11-04T01:02:01.000Z: tick",
      ].join("\n\n"),
    );
  });

  it("indents the notes between markers", () => {
    const text = crashCopyText({ report, webview: "UA", notes: "one\ntwo" });
    expect(text).toContain("User notes:\n--- begin user notes ---\n  one\n  two\n--- end user notes ---");
    expect(text.indexOf("User notes:")).toBeLessThan(text.indexOf("Details:"));
    expect(crashCopyText({ report, webview: "UA", notes: "  \n " })).not.toContain("User notes");
  });

  it("caps the text and says so", () => {
    const big = { ...report, details: [{ key: "k", value: "x".repeat(MAX_COPY) }] };
    const text = crashCopyText({ report: big, webview: "UA" });
    expect(text.length).toBe(MAX_COPY + TRUNCATED.length);
    expect(text.endsWith(TRUNCATED)).toBe(true);
  });

  it("has an uncaptured form with the app details", () => {
    const text = crashCopyText({ report: null, webview: "UA", appVersion: "9" });
    expect(text).toContain("Report ID: not captured");
    expect(text).toContain("Status: uncaptured");
    expect(text).toContain("- captured_crash_report: false");
    expect(text).toContain("- report_source: palette");
    expect(text).not.toContain("Recent activity");
  });

  it("summarises a panic and a render error", () => {
    expect(crashSummary(report).what).toBe("app panic");
    expect(crashSummary({ ...report, exitCode: 3 }).what).toBe("app panic (exit 3)");
    expect(crashSummary({ ...report, source: "renderer", details: [{ key: "surface", value: "Terminal" }] }).what).toBe("React render error in Terminal");
    expect(crashSummary(report).where).toBe("2026-11-04 · windows x86_64 · xDev 1.2.3");
  });
});
