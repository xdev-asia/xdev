import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createMockApi } from "@/api";
import { startAutosave } from "./autosave";
import { EDITOR_DEFAULTS } from "./editorDefaults";
import { resetEditorSettingsForTests, setEditorSettings } from "./editorSettings";
import { FileTabs } from "./fileTabs";

const W = "/wt/a";
const t = (k: string) => k;

function setup() {
  const api = createMockApi({});
  const write = vi.spyOn(api, "fileWrite").mockResolvedValue({ type: "saved", hash: "h2" });
  const store = new FileTabs();
  store.open(W, "a.ts");
  store.loaded(W, "a.ts", { rel: "a.ts", text: "one", kind: "text", size: 3, hash: "h1", eol: "lf" });
  const stop = startAutosave(api, store, t);
  return { write, store, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
  resetEditorSettingsForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetEditorSettingsForTests();
});

it("saves once, a delay after the last edit", async () => {
  setEditorSettings({ ...EDITOR_DEFAULTS, autosave: true, autosaveMs: 1000 });
  const { write, store, stop } = setup();
  store.edit(W, "a.ts", "two");
  await vi.advanceTimersByTimeAsync(600);
  // Another edit restarts the wait.
  store.edit(W, "a.ts", "three");
  await vi.advanceTimersByTimeAsync(999);
  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(W, "a.ts", "three", "lf", "h1");
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).toHaveBeenCalledTimes(1);
  expect(store.get(W, "a.ts")).toMatchObject({ saved: "three", hash: "h2" });
  stop();
});

it("does nothing while autosave is off", async () => {
  const { write, store, stop } = setup();
  store.edit(W, "a.ts", "two");
  await vi.advanceTimersByTimeAsync(20000);
  expect(write).not.toHaveBeenCalled();
  stop();
});

it("turning autosave on picks up a file that is already dirty", async () => {
  const { write, store, stop } = setup();
  store.edit(W, "a.ts", "two");
  setEditorSettings({ ...EDITOR_DEFAULTS, autosave: true, autosaveMs: 250 });
  await vi.advanceTimersByTimeAsync(250);
  expect(write).toHaveBeenCalledTimes(1);
  stop();
});

it("never saves a file that has a conflict", async () => {
  setEditorSettings({ ...EDITOR_DEFAULTS, autosave: true, autosaveMs: 250 });
  const { write, store, stop } = setup();
  store.edit(W, "a.ts", "two");
  store.conflict(W, "a.ts", "disk");
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).not.toHaveBeenCalled();
  stop();
});

it("forgets the wait when the tab closes or the stop is called", async () => {
  setEditorSettings({ ...EDITOR_DEFAULTS, autosave: true, autosaveMs: 250 });
  const a = setup();
  a.store.edit(W, "a.ts", "two");
  a.store.close(W, "a.ts");
  await vi.advanceTimersByTimeAsync(1000);
  expect(a.write).not.toHaveBeenCalled();
  const b = setup();
  b.store.edit(W, "a.ts", "two");
  b.stop();
  await vi.advanceTimersByTimeAsync(1000);
  expect(b.write).not.toHaveBeenCalled();
});

it("does not retry a failed autosave of the same text", async () => {
  setEditorSettings({ ...EDITOR_DEFAULTS, autosave: true, autosaveMs: 250 });
  const { write, store, stop } = setup();
  write.mockRejectedValue({ code: "denied" });
  store.edit(W, "a.ts", "two");
  await vi.advanceTimersByTimeAsync(5000);
  expect(write).toHaveBeenCalledTimes(1);
  store.edit(W, "a.ts", "three");
  await vi.advanceTimersByTimeAsync(250);
  expect(write).toHaveBeenCalledTimes(2);
  stop();
});
