import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "./App";
import { CliSkillTip } from "./shell/CliSkillTip";

const onboarding = vi.hoisted(() => ({ wizardOpen: false }));
vi.mock("./onboarding/onboardingStore", () => ({ useOnboarding: () => ({ wizardOpen: onboarding.wizardOpen }) }));

type Node = ReactElement<Record<string, any>>;
const tip = (): Node => {
  const root = App() as Node;
  const kids = Array.isArray(root.props.children) ? (root.props.children as Node[]) : [root.props.children as Node];
  return kids.find((n) => n.type === CliSkillTip)!;
};

it("mounts the CLI skill tip next to the gated shell", () => {
  expect(tip()).toBeDefined();
  expect(tip().props.suppressed).toBe(false);
});

it("keeps the tip away while the wizard is open", () => {
  onboarding.wizardOpen = true;
  expect(tip().props.suppressed).toBe(true);
  onboarding.wizardOpen = false;
});
