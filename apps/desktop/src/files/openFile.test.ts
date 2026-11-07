import { expect, it } from "vitest";
import type { OpenFileRequest } from "./openFile";

it("an open request has no preview flag: every open is a normal tab", () => {
  const keys: (keyof OpenFileRequest)[] = ["worktree", "rel", "line", "column", "side"];
  // A key outside the request type no longer compiles.
  // @ts-expect-error preview was reserved and never read
  const reserved: keyof OpenFileRequest = "preview";
  expect(keys).not.toContain(reserved);
});
