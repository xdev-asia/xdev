import { expect, fitsWidth, test } from "./fixtures";

// Roles on a paired computer, in the browser mock (`src/mockPeers.ts`): a viewer
// cannot type into its terminals, an operator can. No network.

test("typing into a paired computer's terminal needs the operator role at 360px", async ({ page, openApp, problems }) => {
  await page.route(/^(?!http:\/\/(localhost|127\.0\.0\.1)[:/])/, (route) => route.abort());
  await page.setViewportSize({ width: 360, height: 760 });
  await openApp();

  const got = await page.evaluate(async () => {
    type Mock = {
      peerTermWrite(peerId: string, termId: string, data: Uint8Array): Promise<void>;
      peersList(): Promise<{ id: string; theirRole: string | null }[]>;
      __peersSetTheirRole(role: string, peerId?: string): void;
    };
    const mock = (window as unknown as { xdevMock: Mock }).xdevMock;
    const data = new TextEncoder().encode("ls\r");
    mock.__peersSetTheirRole("viewer");
    const asViewer = await mock.peerTermWrite("studio-mac", "review", data).then(
      () => "ok",
      (e: unknown) => e,
    );
    mock.__peersSetTheirRole("operator");
    const asOperator = await mock.peerTermWrite("studio-mac", "review", data).then(
      () => "ok",
      (e: unknown) => e,
    );
    const role = (await mock.peersList()).find((p) => p.id === "studio-mac")?.theirRole;
    return { asViewer, asOperator, role };
  });

  expect(got.asViewer).toEqual({ code: "peer_role" });
  expect(got.asOperator).toBe("ok");
  expect(got.role).toBe("operator");
  expect(await fitsWidth(page)).toBe(true);
  expect(problems).toEqual([]);
});
