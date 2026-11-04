import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { chordLabel } from "@/keys/keymap";
import { IS_MAC } from "@/platform";
import { NavButtons } from "./NavButtons";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string) => translate("en", key);
const buttons = (props: Parameters<typeof NavButtons>[0]) => nodes(NavButtons(props)).filter((n) => n.type === "button");

it("renders two buttons whose disabled state follows the props", () => {
  const [back, forward] = buttons({ canBack: true, canForward: false, onBack() {}, onForward() {} });
  expect(back.props.disabled).toBe(false);
  expect(forward.props.disabled).toBe(true);
  expect(forward.props.title).toBe(en("nav.forward.none"));
});

it("the title holds the chord", () => {
  const [back, forward] = buttons({ canBack: true, canForward: true, onBack() {}, onForward() {} });
  expect(back.props.title).toBe(`${en("nav.back")} (${chordLabel("worktree.history.back", IS_MAC)})`);
  expect(forward.props.title).toBe(`${en("nav.forward")} (${chordLabel("worktree.history.forward", IS_MAC)})`);
  expect(back.props["aria-label"]).toBe(back.props.title);
});

it("a click calls the handler", () => {
  const onBack = vi.fn();
  const onForward = vi.fn();
  const [back, forward] = buttons({ canBack: true, canForward: true, onBack, onForward });
  back.props.onClick();
  forward.props.onClick();
  expect(onBack).toHaveBeenCalledTimes(1);
  expect(onForward).toHaveBeenCalledTimes(1);
});
