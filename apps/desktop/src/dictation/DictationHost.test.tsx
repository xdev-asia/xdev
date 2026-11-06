import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { DictationPill, elapsedLabel } from "./DictationHost";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const render = (props: Partial<Parameters<typeof DictationPill>[0]> = {}) =>
  renderToStaticMarkup(<DictationPill phase="recording" elapsedMs={0} mode="toggle" chord="Ctrl+Shift+Space" t={t} onCancel={vi.fn()} {...props} />);
const count = (html: string, needle: string) => html.split(needle).length - 1;

it("elapsedLabel shows m:ss", () => {
  expect(elapsedLabel(0)).toBe("0:00");
  expect(elapsedLabel(7400)).toBe("0:07");
  expect(elapsedLabel(65_000)).toBe("1:05");
  expect(elapsedLabel(120_000)).toBe("2:00");
});

it("recording: one status region, a danger dot, the time, the hint and a cancel button", () => {
  const html = render({ elapsedMs: 7400 });
  expect(count(html, 'role="status"')).toBe(1);
  expect(html).toContain('aria-live="polite"');
  expect(html).toMatch(/class="ws-dot"[^>]*data-tone="danger"/);
  expect(html).toContain("0:07");
  expect(html).toContain(t("dictation.recording"));
  expect(html).toContain("Press <kbd");
  expect(html).toContain("Ctrl+Shift+Space");
  expect(html).toMatch(/<button[^>]*aria-label="Cancel dictation"/);
  expect(html).not.toContain("btn-primary");
});

it("hold mode hints at the release", () => {
  const html = render({ mode: "hold" });
  expect(html).toContain(t("dictation.hintHold"));
  expect(html).not.toContain("<kbd");
});

it("a chord that is not bound leaves the hint out", () => {
  expect(render({ chord: null })).not.toContain("dictation-hint");
});

it("transcribing: a spinner and the word, no dot", () => {
  const html = render({ phase: "transcribing" });
  expect(html).toContain("x-spinner");
  expect(html).toContain(t("dictation.transcribing"));
  expect(html).not.toContain("ws-dot");
  expect(html).not.toContain("btn-primary");
});

it("starting shows the recording pill at 0:00", () => {
  expect(render({ phase: "starting" })).toContain("0:00");
});

it("idle draws nothing", () => {
  expect(render({ phase: "idle" })).toBe("");
});
