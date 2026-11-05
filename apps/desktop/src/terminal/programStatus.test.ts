import { expect, it } from "vitest";
import { PROGRAM_STATUS_REPLY, parseProgramStatus, toTabStatus } from "./programStatus";

const b64 = (s: string) => btoa(s);

it("reads the probe", () => {
  expect(parseProgramStatus("?")).toEqual({ type: "query" });
});

it("reads each state", () => {
  for (const state of ["idle", "working", "done", "blocked", "error", "clear"]) {
    expect(parseProgramStatus(`state=${state}`)).toMatchObject({ type: "report", state, id: null });
  }
  expect(parseProgramStatus("state=nope")).toBeNull();
});

it("keeps kind only for blocked", () => {
  expect(parseProgramStatus("state=blocked:kind=question")).toMatchObject({ state: "blocked", kind: "question" });
  expect(parseProgramStatus("state=working:kind=question")?.type === "report" && "kind" in parseProgramStatus("state=working:kind=question")!).toBe(false);
  expect(parseProgramStatus("state=blocked:kind=bogus")).toMatchObject({ state: "blocked" });
});

it("keeps progress 0-100 for working and blocked only", () => {
  expect(parseProgramStatus("state=working:progress=0")).toMatchObject({ progress: 0 });
  expect(parseProgramStatus("state=working:progress=100")).toMatchObject({ progress: 100 });
  expect(parseProgramStatus("state=working:progress=007")).toMatchObject({ progress: 7 });
  expect(parseProgramStatus("state=blocked:progress=50")).toMatchObject({ progress: 50 });
  const over = parseProgramStatus("state=working:progress=101");
  expect(over).toMatchObject({ state: "working" });
  expect(over && "progress" in over).toBe(false);
  const idle = parseProgramStatus("state=idle:progress=50");
  expect(idle && "progress" in idle).toBe(false);
});

it("decodes base64 msg and title", () => {
  expect(parseProgramStatus(`state=done:msg=${b64("All done")}:title=${b64("Fix")}`)).toMatchObject({ msg: "All done", title: "Fix" });
  const bad = parseProgramStatus("state=done:msg=%%%");
  expect(bad && "msg" in bad).toBe(false);
});

it("drops an oversized body and a missing state", () => {
  expect(parseProgramStatus("state=working:msg=" + "A".repeat(4088))).toBeNull();
  expect(parseProgramStatus("kind=question")).toBeNull();
  expect(parseProgramStatus("")).toBeNull();
});

it("keeps a child id", () => {
  expect(parseProgramStatus("state=working:id=a/b")).toMatchObject({ id: "a/b" });
});

it("has the exact probe reply", () => {
  expect(PROGRAM_STATUS_REPLY).toBe("\x1b]7501;?:states=idle,working,done,blocked,error:kinds=permission,question,auth\x1b\\");
});

it("maps to a tab status", () => {
  expect(toTabStatus("working")).toBe("working");
  expect(toTabStatus("blocked", "question")).toBe("needs-you");
  expect(toTabStatus("done")).toBe("done");
  expect(toTabStatus("error")).toBe("failed");
  expect(toTabStatus("idle")).toBe("idle");
  expect(toTabStatus("clear")).toBeNull();
});
