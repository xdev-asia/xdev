import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { PeerTermClient } from "./peerTermClient";
import { PeerTerminalView } from "./PeerTerminalTab";
import { closePeerTab, isPeerTab, openPeerTab, peerTabEntries, peerTabId, resetPeerTabs } from "./peerTabs";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const view = (over: Partial<Parameters<typeof PeerTerminalView>[0]> = {}) =>
  renderToStaticMarkup(<PeerTerminalView t={en} computer="studio-mac" tab="review" canControl={false} controlling={false} disconnected={false} onToggle={() => {}} {...over} />).replaceAll("&#x27;", "'");

afterEach(() => resetPeerTabs());

it("a watch tab is read-only and shows Take control only to an Operator", () => {
  const viewer = view();
  expect(viewer).toContain(en("peers.term.readOnly"));
  expect(viewer).not.toContain(en("peers.term.takeControl"));
  expect(view({ canControl: true })).toContain(en("peers.term.takeControl"));
});

it("while typing it says so and offers Stop typing", () => {
  const html = view({ canControl: true, controlling: true });
  expect(html).toContain(en("peers.term.controlling", { tab: "review", computer: "studio-mac" }));
  expect(html).toContain(en("peers.term.releaseControl"));
  expect(html).not.toContain(en("peers.term.readOnly"));
});

it("a dropped link shows the disconnected banner", () => {
  expect(view({ disconnected: true })).toContain(en("peers.term.disconnected", { computer: "studio-mac" }));
  expect(view()).not.toContain(en("peers.term.disconnected", { computer: "studio-mac" }));
});

it("input reaches the other computer only while controlling", async () => {
  const api = createMockApi({});
  const spy = vi.spyOn(api, "peerTermWrite");
  const client = new PeerTermClient(api, "studio-mac", "review");
  await client.start("", "shell", 80, 24, () => {});
  await client.input("ls\r");
  expect(spy).not.toHaveBeenCalled();
  client.controlling = true;
  await client.input("ls\r");
  expect(spy).toHaveBeenCalledOnce();
  await client.dispose();
}, 5000);

it("output of the other computer reaches the view, and a new attach brings it again", async () => {
  const api = createMockApi({});
  const got: string[] = [];
  const client = new PeerTermClient(api, "studio-mac", "review");
  await client.start("", "shell", 80, 24, (bytes) => got.push(new TextDecoder().decode(bytes)));
  expect(got.join("")).toContain("review on studio-mac");
  got.length = 0;
  await client.attach();
  expect(got.join("")).toContain("review on studio-mac");
  await client.dispose();
}, 5000);

it("the tab ids are their own kind and a tab opens once", () => {
  const peer = { id: "studio-mac", name: "studio-mac", theirRole: "operator" as const };
  const id = openPeerTab(peer, { id: "review", title: "review" });
  expect(id).toBe(peerTabId("studio-mac", "review"));
  expect(isPeerTab(id)).toBe(true);
  expect(isPeerTab("file:a.ts")).toBe(false);
  openPeerTab(peer, { id: "review", title: "review" });
  expect(peerTabEntries()).toHaveLength(1);
  expect(peerTabEntries()[0].seq).toBeGreaterThan(1);
  closePeerTab(id);
  expect(peerTabEntries()).toHaveLength(0);
});
