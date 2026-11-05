import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { CliSkillTipView } from "./CliSkillTip";

vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string) => translate("en", key);

const handlers = () => ({ onInstall: vi.fn(), onCopy: vi.fn(), onLater: vi.fn(), onDone: vi.fn() });
const view = (over: Partial<Parameters<typeof CliSkillTipView>[0]> = {}) => {
  const h = handlers();
  const tree = CliSkillTipView({ phase: "idle", copied: false, ...h, ...over });
  const buttons = nodes(tree).filter((n) => n.type === Button);
  const button = (text: string) => buttons.find((n) => n.props.children === text)!;
  return { h, tree, html: renderToStaticMarkup(tree), buttons, button };
};

it("shows the eyebrow, title, example and three buttons with one primary", () => {
  const v = view();
  for (const key of ["tip.eyebrow", "tip.cliSkill.title", "tip.cliSkill.body", "tip.cliSkill.example"]) expect(v.html).toContain(en(key));
  expect(v.html).toContain('role="complementary"');
  expect(v.html).toContain(`aria-label="${en("tip.cliSkill.label")}"`);
  expect(v.buttons.map((b) => b.props.children)).toEqual([en("tip.cliSkill.install"), en("tip.cliSkill.copy"), en("tip.cliSkill.later")]);
  expect(v.buttons.filter((b) => b.props.variant !== "secondary")).toHaveLength(1);
  expect(v.button(en("tip.cliSkill.install")).props.variant).toBeUndefined();
  for (const b of v.buttons) expect(b.props.type).toBe("button");
});

it("the buttons call their handlers", () => {
  const v = view();
  v.button(en("tip.cliSkill.install")).props.onClick();
  v.button(en("tip.cliSkill.copy")).props.onClick();
  v.button(en("tip.cliSkill.later")).props.onClick();
  expect(v.h.onInstall).toHaveBeenCalledTimes(1);
  expect(v.h.onCopy).toHaveBeenCalledTimes(1);
  expect(v.h.onLater).toHaveBeenCalledTimes(1);
  expect(v.h.onDone).not.toHaveBeenCalled();
});

it("installing disables the buttons and says so", () => {
  const v = view({ phase: "installing" });
  expect(v.button(en("tip.cliSkill.installing")).props.disabled).toBe(true);
  expect(v.buttons.every((b) => b.props.disabled === true)).toBe(true);
});

it("installed shows Installed and Done only", () => {
  const v = view({ phase: "installed" });
  expect(v.html).toContain(en("tip.cliSkill.installed"));
  expect(v.buttons.map((b) => b.props.children)).toEqual([en("tip.cliSkill.done")]);
  v.button(en("tip.cliSkill.done")).props.onClick();
  expect(v.h.onDone).toHaveBeenCalledTimes(1);
});

it("copied swaps the copy label", () => {
  const v = view({ copied: true });
  expect(v.buttons.map((b) => b.props.children)).toContain(en("tip.cliSkill.copied"));
  expect(v.html).not.toContain(en("tip.cliSkill.copy"));
});

it("an install error shows its translated code", () => {
  const v = view({ error: "io" });
  expect(v.html).toContain(en("error.io"));
});
