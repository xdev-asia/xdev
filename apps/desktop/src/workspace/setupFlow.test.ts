import { expect, it } from "vitest";
import type { RepoHooks } from "@/api";
import { decideSetup } from "./setupFlow";

const script = (trusted: boolean) => ({ text: "pnpm i", shared: true, hash: "h", trusted });
const hooks = (over: Partial<RepoHooks>): RepoHooks => ({ setup: script(true), archive: null, waitForSetup: false, policy: "run", parseError: null, detected: null, ...over });

it("no setup: offers the detected command, else nothing", () => {
  expect(decideSetup(hooks({ setup: null, detected: "pnpm install" }))).toEqual({ step: "detected", command: "pnpm install" });
  expect(decideSetup(hooks({ setup: null }))).toEqual({ step: "none" });
});

it("skip never runs, even when trusted", () => {
  expect(decideSetup(hooks({ policy: "skip" }))).toEqual({ step: "none" });
});

it("ask offers; run goes ahead only when trusted", () => {
  expect(decideSetup(hooks({ policy: "ask" }))).toEqual({ step: "ask" });
  expect(decideSetup(hooks({ policy: "run" }))).toEqual({ step: "run" });
  expect(decideSetup(hooks({ policy: "run", setup: script(false) }))).toEqual({ step: "trust" });
});
