import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { translate } from "@/i18n";
import { AboutDialog } from "./AboutDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("shows the version with the documentation and source links", () => {
  const html = renderToStaticMarkup(<AboutDialog version="0.3.0" onLink={() => {}} onClose={() => {}} />);
  expect(html).toContain(en("shell.help.about"));
  expect(html).toContain(en("shell.help.aboutVersion", { version: "0.3.0" }));
  expect(html).toContain(en("shell.help.docs"));
  expect(html).toContain(en("shell.help.source"));
  expect(html).toContain(en("shell.help.close"));
});

const day = (secs: number) => new Date(secs * 1000).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
const proState = (updatesUntil: number | null) =>
  ({ state: "active", plan: ["pro"], features: [], freshness: { kind: "fresh" }, pro: updatesUntil === null ? null : { updatesUntil }, syncUntil: null, team: null, device: { fingerprint: "f", max: 1, active: 1 } }) as never;

it("shows the plan line: Free without a license, Pro with one", () => {
  const free = renderToStaticMarkup(<AboutDialog version="1" license={{ state: null, plan: [] }} onLink={() => {}} onClose={() => {}} />);
  expect(free).toContain(en("about.plan", { plan: en("about.plan.free") }));
  const pro = renderToStaticMarkup(<AboutDialog version="1" license={{ state: proState(null), plan: ["pro"] }} onLink={() => {}} onClose={() => {}} />);
  expect(pro).toContain("Plan: Pro");
  expect(pro).not.toContain("about-updates");
});

it("shows the build date and the updates line for Pro", () => {
  const future = Math.floor(Date.now() / 1000) + 86400 * 400;
  const open = renderToStaticMarkup(<AboutDialog version="1" buildDate="2026-11-05" license={{ state: proState(future), plan: ["pro"] }} onLink={() => {}} onClose={() => {}} />);
  expect(open).toContain(en("about.buildDate", { date: "2026-11-05" }));
  expect(open).toContain('data-field="about-updates"');
  expect(open).toContain(en("license.updatesUntil", { date: day(future) }));
  const ended = renderToStaticMarkup(<AboutDialog version="1" license={{ state: proState(1), plan: ["pro"] }} onLink={() => {}} onClose={() => {}} />);
  expect(ended).toContain(en("license.updatesEnded", { date: day(1) }));
});
