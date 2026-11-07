import { expect, it, vi } from "vitest";
import type { MenuEntry } from "@xdev-asia/ui";
import type { TargetsView } from "@/api";
import { translate } from "@/i18n";
import { runTargetEntries } from "./RunTargetsMenu";

const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
type Item = Extract<MenuEntry, { label: string; onSelect?: () => void }> & { type?: "item" };

const view = (over: Partial<TargetsView> = {}): TargetsView => ({
  deploy: [
    { name: "Vercel preview", run: "vercel deploy", confirm: false, source: "detected" },
    { name: "Staging", run: "make stage", confirm: false, source: "repo" },
  ],
  vps: { host: "prod-1", cwd: null, notes: null },
  trusted: true,
  hash: "h",
  text: "x",
  error: null,
  vpsHostKnown: true,
  ...over,
});

const on = () => ({ deploy: vi.fn(), server: vi.fn(), review: vi.fn() });
const items = (entries: MenuEntry[]) => entries.filter((e): e is Item => e.type === undefined || e.type === "item");
const labels = (entries: MenuEntry[]) => entries.map((e) => ("label" in e ? e.label : "-"));

it("shows nothing but the title while loading", () => {
  expect(runTargetEntries(null, t, on())).toEqual([{ type: "group", label: "Run targets" }]);
});

it("groups Deploy and Server, with presets as menu entries", () => {
  const handlers = on();
  const entries = runTargetEntries(view(), t, handlers);
  expect(labels(entries)).toEqual(["Run targets", t("targets.deploy.group"), `Vercel preview · ${t("targets.source.detected")}`, `Staging · ${t("targets.source.repo")}`, t("targets.server.group"), `${t("targets.server.open")} · prod-1`]);
  expect(items(entries).some((e) => e.disabled)).toBe(false);
  items(entries)[1].onSelect!();
  expect(handlers.deploy).toHaveBeenCalledWith(expect.objectContaining({ name: "Staging" }));
  items(entries)[2].onSelect!();
  expect(handlers.server).toHaveBeenCalled();
});

it("disables repo presets and the server shell while untrusted, and offers review", () => {
  const handlers = on();
  const entries = items(runTargetEntries(view({ trusted: false }), t, handlers));
  expect(entries.filter((e) => e.disabled && e.onSelect)).toHaveLength(2);
  // The hint is a disabled entry with nothing to run.
  const hint = entries.find((e) => e.label === t("targets.untrusted.hint"))!;
  expect(hint.disabled).toBe(true);
  expect(hint.onSelect).toBeUndefined();
  entries.find((e) => e.label === t("targets.untrusted.review"))!.onSelect!();
  expect(handlers.review).toHaveBeenCalled();
});

it("says so when nothing is found", () => {
  expect(labels(runTargetEntries(view({ deploy: [], vps: null, hash: "" }), t, on()))).toContain(t("targets.deploy.none"));
  expect(t("targets.deploy.none")).toContain("No deploy targets found");
});

it("warns when the vps host is not known", () => {
  expect(labels(runTargetEntries(view({ vpsHostKnown: false }), t, on()))).toContain(t("targets.vps.noHost", { host: "prod-1" }));
  expect(t("targets.vps.noHost", { host: "prod-1" })).toContain("prod-1 is not in your SSH hosts");
});
