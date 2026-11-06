import { expect, fitsWidth, test } from "./fixtures";

// The paired-computers contract in the browser mock (`src/mockPeers.ts`), which the UI lanes build on.
// No UI exists yet; this checks the shapes `window.xdevMock` returns. No network.

test("the peers mock returns the contract's shapes at 360px", async ({ page, openApp }) => {
  await page.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)[:/])/, (route) => route.abort());
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();

  const got = await page.evaluate(async () => {
    type Mock = {
      peersNearby(): Promise<unknown>;
      peerPairJoin(target: unknown, code: string, grantBack: boolean): Promise<unknown>;
      peerTerms(peerId: string): Promise<unknown>;
    };
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const nearby = await mock.peersNearby();
    const pending = await mock.peerPairJoin({ kind: "nearby", hostId: "build-box" }, "7K4QM-2XD9P", true);
    const wrong = await mock.peerPairJoin({ kind: "nearby", hostId: "build-box" }, "00000-00000", true).catch((e: unknown) => e);
    const terms = await mock.peerTerms("studio-mac");
    return { nearby, pending, wrong, terms };
  });

  expect(got.nearby).toEqual([
    { hostId: "studio-mac", name: null, pairing: false, paired: true },
    { hostId: "build-box", name: "build-box", pairing: true, paired: false },
  ]);
  expect(got.pending).toEqual({ requestId: expect.any(String), sas: "482 913", name: "build-box" });
  expect(got.wrong).toEqual({ code: "pair_code" });
  expect(got.terms).toEqual([
    { id: "review", title: "review", agent: "reviewer", state: "idle", projectId: "app" },
    { id: "shell", title: "shell", agent: null, state: "running", projectId: "app" },
  ]);
  expect(await fitsWidth(page)).toBe(true);
});
