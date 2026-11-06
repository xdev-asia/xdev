import { StatusDot } from "@xdev-asia/ui";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, it, vi } from "vitest";
import type { NotchState } from "@/api";
import { translate } from "@/i18n";
import { nodes, type Node } from "@/kit/testHooks";
import { NotchView, notchLabel } from "./NotchView";

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function draw(state: NotchState, onOpen = vi.fn()) {
  const tree = NotchView({ state, t: en, onOpen });
  return { all: nodes(tree) as Node[], onOpen };
}

it("is empty when hidden", () => {
  expect(NotchView({ state: { view: { kind: "hidden" }, gap: 0 }, t: en, onOpen() {} })).toBeNull();
  expect(notchLabel({ kind: "hidden" }, en)).toBeNull();
});

it("names the agent that waits for input, with the others counted", () => {
  const { all } = draw({ view: { kind: "needs-you", ptyId: "p1", name: "Reviewer", worktree: "/w", others: 2 }, gap: 0 });
  const root = all[0];
  expect(root.props.role).toBe("status");
  expect(root.props["aria-label"]).toBe("Reviewer and 2 more are waiting for you");
  expect(root.props["data-kind"]).toBe("needs-you");
  expect(all.find((n) => n.type === StatusDot)?.props.state).toBe("waiting");
  expect(all.some((n) => n.props.children === "+2 more")).toBe(true);
});

it("names a failed agent", () => {
  const { all } = draw({ view: { kind: "failed", ptyId: "p2", name: "Builder", worktree: "/w", others: 0 }, gap: 0 });
  expect(all[0].props["aria-label"]).toBe("Builder stopped with an error");
  expect(all.find((n) => n.type === StatusDot)?.props.state).toBe("failed");
  expect(all.some((n) => n.props.children === "Error")).toBe(true);
});

it("counts working agents, in the singular for one", () => {
  expect(draw({ view: { kind: "working", ptyId: "p3", count: 3 }, gap: 0 }).all[0].props["aria-label"]).toBe("3 agents working");
  const { all } = draw({ view: { kind: "working", ptyId: "p3", count: 1 }, gap: 0 });
  expect(all[0].props["aria-label"]).toBe("1 agent working");
  expect(all.find((n) => n.type === StatusDot)?.props.pulse).toBe(true);
});

it("leaves the notch's width empty between the wings, and none without a notch", () => {
  const notched = draw({ view: { kind: "working", ptyId: "p3", count: 2 }, gap: 185 }).all;
  expect(notched[0].props["data-notch"]).toBe("");
  expect(notched.find((n) => n.props.className === "notch-gap")?.props.style).toEqual({ width: 185 });
  const flat = draw({ view: { kind: "working", ptyId: "p3", count: 2 }, gap: 0 }).all;
  expect(flat[0].props["data-notch"]).toBeUndefined();
  expect(flat.some((n) => n.props.className === "notch-gap")).toBe(false);
});

it("a click opens that tab, and the button has a name", () => {
  const { all, onOpen } = draw({ view: { kind: "needs-you", ptyId: "p1", name: "Reviewer", worktree: "/w", others: 0 }, gap: 0 });
  const button = all.find((n) => n.type === "button")!;
  expect(button.props.type).toBe("button");
  expect(button.props["aria-label"]).toBe("Reviewer is waiting for you. Open in xDev");
  button.props.onClick();
  expect(onOpen).toHaveBeenCalledWith("p1");
});

it("the strip stops moving under reduced motion and keeps a 24px target", () => {
  const css = readFileSync(fileURLToPath(new URL("./notch.css", import.meta.url)), "utf8");
  expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)\s*\{[^}]*\.notch \*\s*\{[^}]*animation:\s*none/);
  expect(css).toMatch(/\.notch-hit\s*\{[^}]*min-height:\s*24px/);
});
