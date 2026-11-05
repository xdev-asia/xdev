import { expect, it } from "vitest";
import { createMarkdownModeStore, MODE_STORAGE_KEY, type ModeStorage } from "./markdownMode";

function memory(initial?: string): ModeStorage & { data: Map<string, string> } {
  const data = new Map<string, string>(initial === undefined ? [] : [[MODE_STORAGE_KEY, initial]]);
  return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v), removeItem: (k) => void data.delete(k) };
}

it("defaults to source and restores a saved choice in a new store", () => {
  const storage = memory();
  const a = createMarkdownModeStore(() => storage);
  expect(a.get("w", "a.md")).toBe("source");
  a.set("w", "a.md", "preview");
  expect(createMarkdownModeStore(() => storage).get("w", "a.md")).toBe("preview");
  expect(createMarkdownModeStore(() => storage).get("w", "b.md")).toBe("source");
});

it("keeps only the newest entries up to the cap", () => {
  const storage = memory();
  const store = createMarkdownModeStore(() => storage, 3);
  for (const n of ["1", "2", "3", "4"]) store.set("w", n, "preview");
  store.set("w", "2", "source");
  const fresh = createMarkdownModeStore(() => storage, 3);
  expect(fresh.get("w", "1")).toBe("source");
  expect(fresh.get("w", "3")).toBe("preview");
  expect(fresh.get("w", "4")).toBe("preview");
  expect(JSON.parse(storage.data.get(MODE_STORAGE_KEY)!)).toHaveLength(3);
});

it("tolerates unreadable and failing storage", () => {
  expect(createMarkdownModeStore(() => memory("not json")).get("w", "a")).toBe("source");
  expect(createMarkdownModeStore(() => memory('[["w\na","bogus"],5]')).get("w", "a")).toBe("source");
  const broken: ModeStorage = {
    getItem: () => { throw new Error("blocked"); },
    setItem: () => { throw new Error("full"); },
    removeItem: () => { throw new Error("blocked"); },
  };
  const store = createMarkdownModeStore(() => broken);
  store.set("w", "a", "preview");
  expect(store.get("w", "a")).toBe("preview");
  store.reset();
  expect(store.get("w", "a")).toBe("source");
  expect(createMarkdownModeStore(() => null).get("w", "a")).toBe("source");
});

it("tells subscribers about a change", () => {
  const store = createMarkdownModeStore(() => null);
  let n = 0;
  const off = store.subscribe(() => void n++);
  store.set("w", "a", "preview");
  off();
  store.set("w", "a", "source");
  expect(n).toBe(1);
});
