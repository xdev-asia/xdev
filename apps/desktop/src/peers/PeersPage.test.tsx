import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerView } from "@/api";
import { translate } from "@/i18n";
import { PeerRow } from "./PeersPage";
import { adminNameMatches, atLeast, formatCountdown, needsAdminConfirm, rolesFor, sortPeers } from "./peersModel";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const NOW = 1_800_000_000_000;
const peer = (over: Partial<PeerView> = {}): PeerView => ({ id: "p1", name: "build-box", kind: "desktop", role: "viewer", theirRole: "operator", online: true, lastSeenMs: NOW, sameXdevId: false, ...over });
const row = (p: PeerView): string => renderToStaticMarkup(<ul><PeerRow peer={p} t={en} locale="en" now={NOW} onRole={() => {}} onRename={() => {}} onUnpair={() => {}} /></ul>);

it("a desktop row shows its name, online state and all four roles", () => {
  const html = row(peer());
  expect(html).toContain("build-box");
  expect(html).toContain(en("peers.list.online"));
  for (const r of ["none", "viewer", "operator", "admin"]) expect(html).toContain(`value="${r}"`);
  expect(html).toContain(en("peers.role.label", { name: "build-box" }));
});

it("a phone row has the Phone tag and no Admin", () => {
  const html = row(peer({ kind: "phone", name: "pixel" }));
  expect(html).toContain(en("peers.list.phone"));
  expect(html).not.toContain('value="admin"');
  expect(html).not.toContain('value="none"');
  expect(rolesFor("phone")).toEqual(["viewer", "operator"]);
});

it("an offline row says when it was last seen", () => {
  const html = row(peer({ online: false, lastSeenMs: NOW - 5 * 60_000 }));
  expect(html).toContain(en("peers.list.offline"));
  expect(html).toContain("5 minutes ago");
});

it("Admin asks first and the button needs the typed name", () => {
  expect(needsAdminConfirm("admin")).toBe(true);
  expect(needsAdminConfirm("operator")).toBe(false);
  expect(adminNameMatches("", "build-box")).toBe(false);
  expect(adminNameMatches("build", "build-box")).toBe(false);
  expect(adminNameMatches(" build-box ", "build-box")).toBe(true);
});

it("roles are ordered and a missing role is none", () => {
  expect(atLeast("operator", "operator")).toBe(true);
  expect(atLeast("viewer", "operator")).toBe(false);
  expect(atLeast(null, "viewer")).toBe(false);
  expect(atLeast("admin", "operator")).toBe(true);
});

it("lists online computers first, then by name, and counts down in minutes and seconds", () => {
  const names = sortPeers([peer({ id: "a", name: "zed", online: true }), peer({ id: "b", name: "alpha", online: false }), peer({ id: "c", name: "beta", online: true })]).map((p) => p.name);
  expect(names).toEqual(["beta", "zed", "alpha"]);
  expect(formatCountdown(299_000)).toBe("4:59");
  expect(formatCountdown(-5)).toBe("0:00");
});
