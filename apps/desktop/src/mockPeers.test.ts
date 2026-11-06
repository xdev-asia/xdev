import { expect, test, vi } from "vitest";
import type { PeerPairRequest, PeerPairResult, PeersState, PeerTermClosed } from "./api";
import { createMockPeers, MOCK_PAIR_CODE, MOCK_PAIR_SAS } from "./mockPeers";

const WAIT = { timeout: 2000 };

test("the host shows a code, a computer joins, and the host confirms it with a role", async () => {
  const peers = createMockPeers();
  const requests: PeerPairRequest[] = [];
  const results: PeerPairResult[] = [];
  await peers.onPeerPairRequest((r) => requests.push(r));
  await peers.onPeerPairResult((r) => results.push(r));

  const offer = await peers.peerPairStart("lan");
  expect(offer.code).toMatch(/^[0-9A-Z]{5}-[0-9A-Z]{5}$/);
  expect(offer.link.startsWith("xdev://pair?")).toBe(true);
  expect((await peers.peersState()).pairing).toBe(true);

  const id = await peers.__peersPairRequest("dev-laptop");
  expect(requests).toEqual([{ requestId: id, name: "dev-laptop", kind: "desktop", sas: expect.stringMatching(/^\d{3} \d{3}$/) }]);
  await peers.peerPairConfirm(id, true, "viewer");

  expect(results).toEqual([{ ok: true, name: "dev-laptop", error: null }]);
  const added = (await peers.peersList()).find((p) => p.name === "dev-laptop");
  expect(added).toMatchObject({ role: "viewer", theirRole: null, online: true });
  // The offer is single use.
  expect((await peers.peersState()).pairing).toBe(false);
});

test("joining build-box with its code shows the SAS and pairs once confirmed", async () => {
  const peers = createMockPeers();
  const results: PeerPairResult[] = [];
  await peers.onPeerPairResult((r) => results.push(r));
  expect((await peers.peersNearby()).find((n) => n.hostId === "build-box")).toMatchObject({ pairing: true, paired: false });

  const pending = await peers.peerPairJoin({ kind: "nearby", hostId: "build-box" }, MOCK_PAIR_CODE, true);
  expect(pending).toMatchObject({ sas: MOCK_PAIR_SAS, name: "build-box" });
  await peers.peerPairConfirm(pending.requestId, true, "viewer");

  await vi.waitFor(() => expect(results).toEqual([{ ok: true, name: "build-box", error: null }]), WAIT);
  expect((await peers.peersList()).find((p) => p.id === "build-box")).toMatchObject({ role: "viewer", theirRole: "operator", online: true });
  expect((await peers.peersNearby()).find((n) => n.hostId === "build-box")).toMatchObject({ pairing: false, paired: true });
});

test("a wrong code rejects pair_code", async () => {
  const peers = createMockPeers();
  await expect(peers.peerPairJoin({ kind: "nearby", hostId: "build-box" }, "AAAAA-AAAAA", false)).rejects.toEqual({ code: "pair_code" });
  await expect(peers.peerPairJoin({ kind: "nearby", hostId: "nowhere" }, MOCK_PAIR_CODE, false)).rejects.toEqual({ code: "peer_offline" });
});

test("a dropped peer goes offline, emits peers://changed and closes its terminals", async () => {
  const peers = createMockPeers();
  const states: PeersState[] = [];
  const closed: PeerTermClosed[] = [];
  await peers.onPeersChanged((s) => states.push(s));
  await peers.onPeerTermClosed((e) => closed.push(e));
  const chunks: Uint8Array[] = [];
  expect(await peers.peerTermAttach("studio-mac", "review", (b) => chunks.push(b))).toEqual({ cols: 100, rows: 30 });

  peers.__peersDrop("studio-mac");

  expect(states).toHaveLength(1);
  expect((await peers.peersList()).find((p) => p.id === "studio-mac")?.online).toBe(false);
  expect(closed).toEqual([{ peerId: "studio-mac", termId: "review", reason: "offline" }]);
  await expect(peers.peerTerms("studio-mac")).rejects.toEqual({ code: "peer_offline" });
});

test("an attached terminal streams lines until detached", async () => {
  const peers = createMockPeers();
  const dec = new TextDecoder();
  const lines: string[] = [];
  await peers.peerTermAttach("studio-mac", "review", (b) => lines.push(dec.decode(b)));
  await vi.waitFor(() => expect(lines.some((l) => l.includes("line 1"))).toBe(true), WAIT);
  await peers.peerTermDetach("studio-mac", "review");
  const n = lines.length;
  await new Promise((r) => setTimeout(r, 700));
  expect(lines).toHaveLength(n);
});

test("roles gate what this computer may do on studio-mac", async () => {
  const peers = createMockPeers();
  expect((await peers.peerProjects("studio-mac")).map((p) => p.id)).toEqual(["app"]);
  expect((await peers.peerTerms("studio-mac")).map((t) => t.id)).toEqual(["review", "shell"]);
  // We are Operator there: typing and starting agents work.
  await peers.peerTermWrite("studio-mac", "shell", new TextEncoder().encode("ls\r"));
  const term = await peers.peerAgentStart("studio-mac", "app", "reviewer", null);
  expect(term).toMatchObject({ agent: "reviewer", state: "running", projectId: "app" });

  const pending = await peers.peerPairJoin({ kind: "nearby", hostId: "build-box" }, MOCK_PAIR_CODE, false);
  await peers.peerPairConfirm(pending.requestId, true, "viewer");
  // Without grant back, build-box gets no access here.
  await vi.waitFor(async () => expect((await peers.peersList()).find((p) => p.id === "build-box")?.role).toBe("none"), WAIT);
});

test("activity and confirm hooks emit their events", async () => {
  const peers = createMockPeers();
  const seen: unknown[] = [];
  await peers.onPeerActivity((e) => seen.push(e));
  await peers.onPeerConfirm((e) => seen.push(e));
  peers.__peersActivity();
  const id = await peers.__peersConfirm();
  expect(seen).toEqual([
    { peer: "studio-mac", action: "typed", target: "review" },
    { requestId: id, peer: "studio-mac", action: "start an agent", target: "app" },
  ]);
  await peers.peerConfirmReply(id, true);
  await expect(peers.peerConfirmReply(id, true)).rejects.toEqual({ code: "not_found" });
});

test("a viewer cannot type into a paired computer's terminal; an operator can", async () => {
  const peers = createMockPeers();
  const data = new TextEncoder().encode("ls\r");
  peers.__peersSetTheirRole("viewer");
  await expect(peers.peerTermWrite("studio-mac", "review", data)).rejects.toEqual({ code: "peer_role" });
  // A viewer still sees the tabs.
  expect((await peers.peerTerms("studio-mac")).map((t) => t.id)).toEqual(["review", "shell"]);
  peers.__peersSetTheirRole("operator");
  await expect(peers.peerTermWrite("studio-mac", "review", data)).resolves.toBeUndefined();
});

test("a paired computer whose person says no answers peer_denied until that stops", async () => {
  const peers = createMockPeers();
  const data = new TextEncoder().encode("ls\r");
  peers.__peersConfirmDeny();
  await expect(peers.peerTermWrite("studio-mac", "review", data)).rejects.toEqual({ code: "peer_denied" });
  await expect(peers.peerAgentStart("studio-mac", "app", "claude", null)).rejects.toEqual({ code: "peer_denied" });
  // The role check comes first.
  peers.__peersSetTheirRole("viewer");
  await expect(peers.peerTermWrite("studio-mac", "review", data)).rejects.toEqual({ code: "peer_role" });
  peers.__peersSetTheirRole("operator");
  peers.__peersConfirmDeny(false);
  await expect(peers.peerTermWrite("studio-mac", "review", data)).resolves.toBeUndefined();
});
