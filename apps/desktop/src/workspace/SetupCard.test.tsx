import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { SetupCard, type SetupCardState } from "./SetupCard";

vi.mock("@/i18n", async (original) => ({
  ...await original<typeof import("@/i18n")>(),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const actions = { onOpenTabs: vi.fn(), onSave: vi.fn(), onConfigure: vi.fn(), onDismiss: vi.fn(), onRun: vi.fn(), onSkip: vi.fn(), onAlways: vi.fn(), onStartNow: vi.fn(), onOpenSetup: vi.fn() };
const draw = (state: SetupCardState) => nodes(SetupCard({ state, ...actions }));
const press = (all: Node[], label: string) => all.find((n) => n.type === "button" && n.props.children === label)!.props.onClick();
const labels = (all: Node[]) => all.filter((n) => n.type === "button").map((n) => n.props.children);
const said = (all: Node[]) => all.flatMap((n) => (typeof n.props.children === "string" ? [n.props.children] : [])).join("|");

it("detected: shows the command and saves, configures or dismisses", () => {
  const all = draw({ kind: "detected", command: "pnpm install" });
  expect(all.some((n) => n.type === "code" && n.props.children === "pnpm install")).toBe(true);
  press(all, en("setup.card.save"));
  expect(actions.onSave).toHaveBeenCalledOnce();
  press(all, en("setup.card.configure"));
  expect(actions.onConfigure).toHaveBeenCalledOnce();
  press(all, en("setup.card.dismiss"));
  expect(actions.onDismiss).toHaveBeenCalledOnce();
});

it("ask: runs, skips or always runs", () => {
  const all = draw({ kind: "ask" });
  press(all, en("setup.card.run"));
  press(all, en("setup.card.skip"));
  press(all, en("setup.card.always"));
  expect(actions.onRun).toHaveBeenCalledOnce();
  expect(actions.onSkip).toHaveBeenCalledOnce();
  expect(actions.onAlways).toHaveBeenCalledOnce();
});

it("waiting offers Start now; failed shows the code with two choices", () => {
  const waiting = draw({ kind: "waiting" });
  expect(said(waiting)).toContain(en("setup.card.waiting"));
  press(waiting, en("setup.card.startNow"));
  expect(actions.onStartNow).toHaveBeenCalledOnce();
  const failed = draw({ kind: "failed", code: 3 });
  expect(said(failed)).toContain("Setup failed (code 3)");
  expect(labels(failed)).toEqual([en("setup.card.startAnyway"), en("setup.card.openSetup")]);
  press(failed, en("setup.card.startAnyway"));
  press(failed, en("setup.card.openSetup"));
  expect(actions.onStartNow).toHaveBeenCalledTimes(2);
  expect(actions.onOpenSetup).toHaveBeenCalledOnce();
});

it("is a plain bordered panel: no stripe, no inline colour", () => {
  const root = draw({ kind: "ask" })[0];
  expect(root.props.className).toBe("ws-setup-card");
  expect(root.props.style).toBeUndefined();
});

it("a failure with default tabs waiting offers them; without a waiting agent there is no Start anyway", () => {
  const failed = draw({ kind: "failed", code: 1, agent: false, tabs: true });
  expect(labels(failed)).toEqual([en("setup.card.openSetup"), en("setup.card.openTabs")]);
});
