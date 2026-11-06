import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { PeerPairRequest } from "@/api";
import { translate } from "@/i18n";
import { PairRequestDialog, startRoles } from "./PairRequestDialog";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const request = (over: Partial<PeerPairRequest> = {}): PeerPairRequest => ({ requestId: "r1", name: "dev-laptop", kind: "desktop", sas: "271 604", ...over });

it("shows who asks, the digits, and Viewer and Operator to start with", () => {
  const html = renderToStaticMarkup(<PairRequestDialog request={request()} onAnswer={() => {}} />).replaceAll("&#x27;", "'");
  expect(html).toContain(en("peers.pair.request", { name: "dev-laptop" }));
  expect(html).toContain("271 604");
  expect(html).toContain(en("peers.pair.match"));
  expect(html).toContain(en("peers.pair.noMatch"));
  expect(html).toContain('value="viewer"');
  expect(html).toContain('value="operator"');
  expect(html).not.toContain('value="admin"');
  expect(html).not.toContain('value="none"');
});

it("starts as Viewer and offers no Admin, to a phone too", () => {
  expect(startRoles("desktop")).toEqual(["viewer", "operator"]);
  expect(startRoles("phone")).toEqual(["viewer", "operator"]);
  expect(renderToStaticMarkup(<PairRequestDialog request={request()} onAnswer={() => {}} />)).toMatch(/<option value="viewer" selected|value="viewer"[^>]*selected/);
});
