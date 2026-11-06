import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { MOCK_PAIR_CODE, MOCK_PAIR_SAS } from "@/mockPeers";
import { HostCode, PairDialog } from "./PairDialog";
import { errorText } from "./peersModel";
import { SasCheck } from "./SasCheck";
import { groupCode, normalizeCode } from "@xdev-asia/ui";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const host = (remainingMs: number) => renderToStaticMarkup(<HostCode t={en} code="H3RW8-5MNTA" remainingMs={remainingMs} onCopy={() => {}} onNew={() => {}} />);

it("the code counts down in minutes and seconds", () => {
  const html = host(299_000);
  expect(html).toContain('<span class="x-pairing-code-group">H3RW8</span><span class="x-pairing-code-group">5MNTA</span>');
  expect(html).toContain("H3RW8 5MNTA");
  expect(html).toContain(en("peers.pair.expires", { time: "4:59" }));
  expect(html).not.toContain(en("peers.pair.newCode"));
});

it("when the time is up the code goes and a New code button comes", () => {
  const html = host(0);
  expect(html).toContain(en("peers.pair.newCode"));
  expect(html).toContain(en("peers.pair.expired"));
  expect(html).not.toContain("H3RW8-5MNTA");
});

it("opens on Show a code with both tabs", () => {
  const html = renderToStaticMarkup(<PairDialog api={createMockApi({})} onClose={() => {}} onPaired={() => {}} />);
  expect(html).toContain(en("peers.pair.tab.host"));
  expect(html).toContain(en("peers.pair.tab.join"));
});

it("a join with the mock code gives the digits to compare, then the person is paired", async () => {
  const api = createMockApi({});
  // The dialog sends the code as shown, in two groups.
  const sent = groupCode(normalizeCode("7k4qm 2xd9p"), 5).join("-");
  expect(sent).toBe(MOCK_PAIR_CODE);
  const pending = await api.peerPairJoin({ kind: "nearby", hostId: "build-box" }, sent, false);
  expect(pending.sas).toBe(MOCK_PAIR_SAS);
  expect(pending.name).toBe("build-box");
  expect(renderToStaticMarkup(<SasCheck sas={pending.sas} name={pending.name} />)).toContain(MOCK_PAIR_SAS);

  const result = new Promise<{ ok: boolean; name: string | null }>((resolve) => void api.onPeerPairResult(resolve));
  await api.peerPairConfirm(pending.requestId, true, "none");
  expect(await result).toMatchObject({ ok: true, name: "build-box" });
  expect((await api.peersList()).some((p) => p.name === "build-box")).toBe(true);
}, 5000);

it("a wrong code says the code does not match", async () => {
  const api = createMockApi({});
  const error = await api.peerPairJoin({ kind: "nearby", hostId: "build-box" }, "AAAAA-AAAAA", false).catch((e: unknown) => e);
  expect(errorText(en, error)).toBe(en("peers.error.pair_code"));
});
