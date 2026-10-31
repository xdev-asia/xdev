import { describe, expect, it } from "vitest";
import { docReducer, initialDocState, isDirty, type DocAction, type DocState } from "./docState";

function from(state: DocState, ...actions: DocAction[]): DocState {
  return actions.reduce(docReducer, state);
}

function run(...actions: DocAction[]): DocState {
  return from(initialDocState, ...actions);
}

const loaded: DocAction = { type: "loaded", path: "a.md", content: "v1" };

describe("docReducer", () => {
  it("load sets saved and draft", () => {
    const s = run({ type: "loadStarted", path: "a.md" }, loaded);
    expect(s).toMatchObject({ path: "a.md", saved: "v1", draft: "v1", status: "idle" });
    expect(isDirty(s)).toBe(false);
  });

  it("loadStarted switches path and shows loading", () => {
    expect(run(loaded, { type: "loadStarted", path: "b.md" })).toMatchObject({ path: "b.md", status: "loading" });
  });

  it("edit makes dirty", () => {
    expect(isDirty(run(loaded, { type: "edited", content: "v2" }))).toBe(true);
  });

  it("saved clears dirty", () => {
    const s = run(loaded, { type: "edited", content: "v2" }, { type: "saveStarted" }, { type: "saved", content: "v2" });
    expect(isDirty(s)).toBe(false);
    expect(s.status).toBe("idle");
  });

  it("typing during a save stays dirty", () => {
    const s = run(
      loaded,
      { type: "edited", content: "v2" },
      { type: "saveStarted" },
      { type: "edited", content: "v3" },
      { type: "saved", content: "v2" },
    );
    expect(s).toMatchObject({ saved: "v2", draft: "v3", status: "idle" });
    expect(isDirty(s)).toBe(true);
  });

  it("failed save keeps the draft and reports the code", () => {
    const s = run(loaded, { type: "edited", content: "v2" }, { type: "saveStarted" }, { type: "failed", code: "io" });
    expect(s).toMatchObject({ draft: "v2", status: "error", error: "io" });
    expect(isDirty(s)).toBe(true);
  });

  it("external change while clean reloads", () => {
    const s = run(loaded, { type: "externalChange", content: "disk" });
    expect(s).toMatchObject({ saved: "disk", draft: "disk", status: "idle" });
  });

  it("external change while dirty raises conflict", () => {
    const s = run(loaded, { type: "edited", content: "mine" }, { type: "externalChange", content: "disk" });
    expect(s).toMatchObject({ saved: "v1", draft: "mine", status: "conflict", diskVersion: "disk" });
  });

  it("own write echo is ignored", () => {
    const before = run(loaded, { type: "edited", content: "v2" }, { type: "saveStarted" }, { type: "saved", content: "v2" });
    expect(docReducer(before, { type: "externalChange", content: "v2" })).toBe(before);
    const typing = docReducer(before, { type: "edited", content: "v3" });
    expect(docReducer(typing, { type: "externalChange", content: "v2" })).toBe(typing);
  });

  it("disk catching up with the draft is not a conflict", () => {
    const s = run(loaded, { type: "edited", content: "v2" }, { type: "externalChange", content: "v2" });
    expect(s.status).toBe("idle");
    expect(isDirty(s)).toBe(false);
  });

  it("keep mine then save overwrites", () => {
    const conflict = run(loaded, { type: "edited", content: "mine" }, { type: "externalChange", content: "disk" });
    const kept = docReducer(conflict, { type: "resolveKeepMine" });
    expect(kept).toMatchObject({ saved: "disk", draft: "mine", status: "idle", diskVersion: undefined });
    expect(isDirty(kept)).toBe(true);
    const s = from(kept, { type: "saveStarted" }, { type: "saved", content: "mine" });
    expect(s).toMatchObject({ saved: "mine", draft: "mine", status: "idle" });
  });

  it("reload discards draft", () => {
    const conflict = run(loaded, { type: "edited", content: "mine" }, { type: "externalChange", content: "disk" });
    const s = docReducer(conflict, { type: "resolveReload" });
    expect(s).toMatchObject({ saved: "disk", draft: "disk", status: "idle", diskVersion: undefined });
    expect(isDirty(s)).toBe(false);
  });

  it("a newer disk version during a conflict replaces the old one", () => {
    const s = run(
      loaded,
      { type: "edited", content: "mine" },
      { type: "externalChange", content: "disk1" },
      { type: "externalChange", content: "disk2" },
    );
    expect(s).toMatchObject({ status: "conflict", diskVersion: "disk2" });
  });
});
