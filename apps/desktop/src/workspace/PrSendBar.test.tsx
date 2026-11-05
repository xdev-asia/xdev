import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { PrSendBar } from "./PrSendBar";
import type { Sessions } from "./sessions";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const sessions = { tabs: () => [] } as unknown as Sessions;
const base = { sessions, worktree: "/w", onSend: async () => ({ ok: true, summary: null }), onClear() {} };

it("shows nothing to send for an empty queue", () => {
  const html = renderToStaticMarkup(<PrSendBar {...base} count={0} />);
  expect(html).not.toContain(en("prc.send.clear"));
});

it("counts the queue, and the GitHub option starts off", () => {
  const html = renderToStaticMarkup(<PrSendBar {...base} count={3} initialOpen />);
  expect(html).toContain(en("prc.send.agent", { count: 3 }));
  expect(html).toContain(en("prc.send.ack"));
  expect(html).not.toContain("checked");
});

it("says what the acknowledgement did", () => {
  const html = renderToStaticMarkup(<PrSendBar {...base} count={0} initialSummary={{ resolved: 2, replied: 1, skipped: 0, failed: 1 }} />);
  expect(html).toContain("Sent to the agent. Marked 2 resolved, replied to 1, skipped 0, failed 1.");
});
