import type { CrashDetail, CrashReport } from "@/api";

/** The most characters a copy carries; a longer text is cut and says so. */
export const MAX_COPY = 64_000;
export const TRUNCATED = "\n\n[Crash Report truncated.]";
/** The most characters of the person's notes. */
export const MAX_NOTES = 8000;

const iso = (ms: number): string => {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? String(ms) : d.toISOString();
};

const pairs = (data: CrashDetail[]): string => data.map((d) => `${d.key}=${d.value}`).join(", ");

export type CopyInput = {
  // null when no report was captured: the text still carries the app details.
  report: CrashReport | null;
  notes?: string;
  webview?: string;
  appVersion?: string;
  platform?: string;
};

/** The text the person copies into an issue. Redaction already happened in Rust; nothing is added here. */
export function crashCopyText(input: CopyInput): string {
  const { report, notes = "" } = input;
  const webview = input.webview ?? (typeof navigator === "undefined" ? "unknown" : navigator.userAgent);
  const head = report
    ? [
        `Report ID: ${report.id}`,
        `Created: ${iso(report.createdAt)}`,
        `Status: ${report.status}`,
        `Source: ${report.source}`,
        `Process: ${report.process}`,
        `Reason: ${report.reason}`,
        `Exit code: ${report.exitCode ?? "none"}`,
        `App version: ${report.appVersion}`,
        `Platform: ${report.platform} ${report.arch}`,
        `WebView: ${webview}`,
      ]
    : [
        "Report ID: not captured",
        `Created: ${iso(Date.now())}`,
        "Status: uncaptured",
        `App version: ${input.appVersion ?? "unknown"}`,
        `Platform: ${input.platform ?? "unknown"}`,
        `WebView: ${webview}`,
      ];
  const details: CrashDetail[] = report ? report.details : [
    { key: "captured_crash_report", value: "false" },
    { key: "report_source", value: "palette" },
  ];
  const parts = ["[Crash Report]", head.join("\n")];
  const trimmed = notes.slice(0, MAX_NOTES).trim();
  if (trimmed) {
    const lines = trimmed.split(/\r?\n/).map((l) => `  ${l}`);
    parts.push(["User notes:", "--- begin user notes ---", ...lines, "--- end user notes ---"].join("\n"));
  }
  parts.push(["Details:", ...details.map((d) => `- ${d.key}: ${d.value}`)].join("\n"));
  if (report && report.breadcrumbs.length > 0) {
    parts.push(
      [
        "Recent activity:",
        ...report.breadcrumbs.map((b) => `- ${iso(b.at)}: ${b.name}${b.data.length > 0 ? ` (${pairs(b.data)})` : ""}`),
      ].join("\n"),
    );
  }
  const text = parts.join("\n\n");
  return text.length > MAX_COPY ? text.slice(0, MAX_COPY) + TRUNCATED : text;
}

/** The first line of the dialog: what happened, then when and where. */
export function crashSummary(report: CrashReport): { what: string; where: string } {
  const surface = report.details.find((d) => d.key === "surface")?.value;
  const what =
    report.source === "renderer"
      ? `React render error in ${surface ?? "the app"}`
      : `${report.process} ${report.reason}${report.exitCode === null ? "" : ` (exit ${report.exitCode})`}`;
  return { what, where: `${iso(report.createdAt).slice(0, 10)} · ${report.platform} ${report.arch} · xDev ${report.appVersion}` };
}
