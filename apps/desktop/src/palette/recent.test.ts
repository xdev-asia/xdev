import { expect, it } from "vitest";
import { RECENT_KEY, RecentStore } from "./recent";

function memory(): Storage & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (k) => void data.delete(k),
    setItem: (k, v) => void data.set(k, v),
  };
}

it("recent store moves forward only", () => {
  let now = 100;
  const store = new RecentStore(null, () => now);
  expect(store.at("wt:/a")).toBeNull();
  store.touch("wt:/a");
  expect(store.at("wt:/a")).toBe(100);
  now = 50;
  store.touch("wt:/a");
  expect(store.at("wt:/a")).toBe(100);
  now = 200;
  store.touch("wt:/a");
  expect(store.at("wt:/a")).toBe(200);
});

it("worktree ids persist, tab ids do not", () => {
  const storage = memory();
  const first = new RecentStore(storage, () => 10);
  first.touch("wt:/a");
  first.touch("tab:p1");
  const second = new RecentStore(storage, () => 20);
  expect(second.at("wt:/a")).toBe(10);
  expect(second.at("tab:p1")).toBeNull();
  expect(JSON.parse(storage.data.get(RECENT_KEY)!)).toEqual({ "wt:/a": 10 });
});

it("caps at 100, dropping the oldest", () => {
  const storage = memory();
  let now = 0;
  const store = new RecentStore(storage, () => now);
  for (let i = 0; i < 101; i++) {
    now = i + 1;
    store.touch(`wt:/w${i}`);
  }
  const saved = JSON.parse(storage.data.get(RECENT_KEY)!);
  expect(Object.keys(saved)).toHaveLength(100);
  expect(saved["wt:/w0"]).toBeUndefined();
  expect(new RecentStore(storage).at("wt:/w100")).toBe(101);
});

it("storage errors are ignored", () => {
  const broken = memory();
  broken.getItem = () => { throw new Error("denied"); };
  broken.setItem = () => { throw new Error("full"); };
  const store = new RecentStore(broken, () => 5);
  store.touch("wt:/a");
  expect(store.at("wt:/a")).toBe(5);
  const bad = memory();
  bad.setItem(RECENT_KEY, "not json");
  expect(new RecentStore(bad).at("wt:/a")).toBeNull();
});
