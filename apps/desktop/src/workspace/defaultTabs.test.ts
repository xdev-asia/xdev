import { expect, it, vi } from "vitest";
import { openDefaultTabs, tabColorOf } from "./defaultTabs";
import type { Sessions } from "./sessions";

it("maps a hex colour to the nearest tab colour token by hue", () => {
  expect(tabColorOf("#f00")).toBe("c1");
  expect(tabColorOf("#ff8800")).toBe("c2");
  expect(tabColorOf("#ffcc00")).toBe("c3");
  expect(tabColorOf("#3c6")).toBe("c4");
  expect(tabColorOf("#4a9")).toBe("c5");
  expect(tabColorOf("#00ffff")).toBe("c5");
  expect(tabColorOf("#2f62e6")).toBe("c6");
  expect(tabColorOf("#a060ff")).toBe("c8");
  expect(tabColorOf("#ff00aa")).toBe("c9");
  expect(tabColorOf("#888888")).toBe("c10");
});

it("a missing or malformed colour is none", () => {
  for (const bad of [null, "", "red", "#12", "#12345g", "123456"]) expect(tabColorOf(bad)).toBe("none");
});

it("opens one shell tab per entry, names and colours it and runs its command", () => {
  const inputs: [string, string][] = [];
  let n = 0;
  const sessions = {
    open: vi.fn(() => {
      const id = `t${++n}`;
      return { id, client: { typeWhenReady: (bytes: string) => void inputs.push([id, bytes]) } };
    }),
    rename: vi.fn(),
    setColor: vi.fn(),
  };
  openDefaultTabs(sessions as unknown as Sessions, "/wt", [
    { title: "dev", color: "#4a9", command: "pnpm dev" },
    { title: "tests", color: null, command: "cargo watch\ncargo test" },
  ], "shell");
  expect(sessions.open.mock.calls).toEqual([["/wt", "shell"], ["/wt", "shell"]]);
  expect(sessions.rename.mock.calls).toEqual([["t1", "dev"], ["t2", "tests"]]);
  expect(sessions.setColor.mock.calls).toEqual([["t1", "c5"]]);
  expect(inputs).toEqual([["t1", "pnpm dev\r"], ["t2", "cargo watch\rcargo test\r"]]);
});
