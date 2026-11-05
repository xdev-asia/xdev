import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { FlowView, Progress } from "./OnboardingFlow";
import { flowReducer, initialFlow, STEPS, type FlowState } from "./flowModel";
import { SetupGuideView } from "./SetupGuide";
import { SetupGuideButton } from "./SetupGuideEntry";
import { deriveChecklist } from "./checklist";
import { LanguageStep } from "./steps/LanguageStep";
import { NotificationsStep } from "./steps/NotificationsStep";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const noop = () => {};
const view = (flow: FlowState, extra: { busy?: boolean; failed?: boolean } = {}) =>
  renderToStaticMarkup(<FlowView flow={flow} busy={extra.busy ?? false} failed={extra.failed ?? false} body={<p>body</p>} onBack={noop} onNext={noop} onFinish={noop} onSkip={noop} onConfirmSkip={noop} onCancelSkip={noop} />);
const primaries = (html: string) => html.match(/class="btn"/g)?.length ?? 0;
const last = (): FlowState => ({ ...initialFlow(), step: STEPS.length - 1 });

it("shows progress as step n of m and marks the current step", () => {
  const html = renderToStaticMarkup(<Progress step={1} />);
  expect(html).toContain(en("onboarding.stepOf", { step: 2, total: STEPS.length }));
  expect(html).toContain('aria-current="step"');
  expect(html.match(/data-state="done"/g)).toHaveLength(1);
});

it("first step: Back is disabled, Next shows, and no primary button yet", () => {
  const html = view(initialFlow());
  expect(html).toContain(en("onboarding.next"));
  expect(html).not.toContain(en("onboarding.finish"));
  expect(html).toMatch(/disabled=""[^>]*>[^<]*Back|Back[^<]*<\/button>/);
  expect(primaries(html)).toBe(0);
});

it("last step: Finish is the one primary button and Next is gone", () => {
  const html = view(last());
  expect(html).toContain(en("onboarding.finish"));
  expect(html).not.toContain(en("onboarding.next"));
  expect(primaries(html)).toBe(1);
  expect(html).toMatch(new RegExp(`class="btn"[^>]*>${en("onboarding.finish")}<`));
});

it("every step keeps a Skip button, and a failed save shows an alert", () => {
  expect(view(initialFlow())).toContain(en("onboarding.skip"));
  expect(view(last(), { failed: true })).toContain(en("onboarding.saveFailed"));
});

it("Skip opens the confirm dialog with Skip setup and Keep going; nothing before", () => {
  expect(view(initialFlow())).not.toContain("dialog");
  const html = view(flowReducer(initialFlow(), { type: "askSkip" }));
  expect(html).toContain(en("onboarding.skip.title"));
  expect(html).toContain(en("onboarding.skip.confirm"));
  expect(html).toContain(en("onboarding.skip.cancel"));
});

it("the notification step offers Allow until it is allowed, then says so", () => {
  const ask = renderToStaticMarkup(<NotificationsStep answers={{}} busy={false} onAllow={noop} />);
  expect(ask).toContain(en("onboarding.notifications.allow"));
  expect(renderToStaticMarkup(<NotificationsStep answers={{ notifications: "denied" }} busy={false} onAllow={noop} />)).toContain(en("onboarding.notifications.denied"));
  const done = renderToStaticMarkup(<NotificationsStep answers={{ notifications: "allowed" }} busy={false} onAllow={noop} />);
  expect(done).toContain(en("onboarding.notifications.allowed"));
  expect(done).not.toContain("<button");
});

it("the language step lists both languages with the current one checked", () => {
  const html = renderToStaticMarkup(<LanguageStep onAnswer={noop} />);
  expect(html).toContain(en("language.vi"));
  expect(html).toMatch(/value="en"[^>]*checked|checked[^>]*value="en"/);
});

const rows = (done: boolean) => deriveChecklist({ defaultAgent: done ? "claude" : "auto", theme: done ? "dark" : "system", storedLocale: done, projects: done ? 1 : 0 }, done ? { notifications: "allowed" } : {});

it("the sidebar entry shows the count while setup is open", () => {
  const html = renderToStaticMarkup(<SetupGuideButton rows={deriveChecklist({ defaultAgent: "claude", theme: "system", storedLocale: false, projects: 0 }, {})} onOpen={noop} />);
  expect(html).toContain(en("onboarding.entry"));
  expect(html).toContain(en("onboarding.guide.progress", { done: 1, total: 5 }));
});

it("the sidebar entry is hidden once every item is done, and while unread", () => {
  expect(renderToStaticMarkup(<SetupGuideButton rows={rows(true)} onOpen={noop} />)).toBe("");
  expect(renderToStaticMarkup(<SetupGuideButton rows={null} onOpen={noop} />)).toBe("");
});

it("the guide lists the five items and offers Resume setup", () => {
  const html = renderToStaticMarkup(<SetupGuideView rows={rows(false)} onResume={noop} onClose={noop} />);
  for (const id of ["agent", "theme", "language", "notifications", "project"]) expect(html).toContain(en(`onboarding.guide.item.${id}`));
  expect(html).toContain(en("onboarding.guide.resume"));
  expect(html.match(new RegExp(en("onboarding.guide.todo"), "g"))).toHaveLength(5);
});
