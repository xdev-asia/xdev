import { beforeEach, expect, it, vi } from "vitest";

const lib = vi.hoisted(() => ({ initialize: vi.fn(), render: vi.fn(async () => ({ svg: "<svg></svg>" })) }));
vi.mock("mermaid", () => ({ default: lib }));
const { renderMermaid } = await import("./mermaid");

beforeEach(() => {
  lib.initialize.mockClear();
  lib.render.mockClear();
});

it("initializes mermaid once for a theme, however many diagrams are drawn", async () => {
  const theme = { lineColor: "#111" };
  await renderMermaid("a", "graph TD; A-->B", theme);
  await renderMermaid("b", "graph TD; B-->C", { ...theme });
  await renderMermaid("c", "graph TD; C-->D", { ...theme });
  expect(lib.render).toHaveBeenCalledTimes(3);
  expect(lib.initialize).toHaveBeenCalledTimes(1);
  expect(lib.initialize).toHaveBeenCalledWith(expect.objectContaining({ securityLevel: "strict", themeVariables: theme }));
});

it("initializes again when the theme changes", async () => {
  await renderMermaid("a", "x", { lineColor: "#111" });
  lib.initialize.mockClear();
  await renderMermaid("b", "x", { lineColor: "#eee" });
  expect(lib.initialize).toHaveBeenCalledTimes(1);
  await renderMermaid("c", "x", { lineColor: "#eee" });
  expect(lib.initialize).toHaveBeenCalledTimes(1);
});
