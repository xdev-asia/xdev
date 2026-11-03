import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi, type PtyExit } from "@/api";
import { translate } from "@/i18n";
import { Terminal } from "./Terminal";
import { TerminalView } from "./TerminalView";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void | (() => void))[] }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  // The profile store is outside what these tests render; its context keeps the default.
  useContext: (ctx: { _currentValue: unknown }) => ctx._currentValue,
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  },
  useEffect: (effect: () => void) => { hooks.effects.push(effect); },
}));
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// xterm needs a real canvas; the view is tested around it.
vi.mock("./Terminal", () => ({ Terminal: () => null }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
function harness(api = createMockApi({})) {
  const draw = () => { hooks.cursor = 0; return TerminalView({ api }); };
  const html = () => renderToStaticMarkup(draw());
  const find = (pick: (n: Node) => boolean) => nodes(draw()).find(pick);
  const button = (text: string) => find((n) => n.props.children === text && n.props.onClick)!;
  const terminal = () => find((n) => n.type === Terminal);
  const dialog = () => find((n) => typeof n.props.onConfirm === "function")!;
  return { api, html, find, button, terminal, dialog };
}
beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; });

async function startClaude(view: ReturnType<typeof harness>) {
  view.button("Choose folder…").props.onClick();
  await tick();
  view.find((n) => n.type === "select")!.props.onChange({ target: { value: "claude" } });
  view.button("Start").props.onClick();
}

it("waits for a folder before it can start", () => {
  const view = harness();
  expect(view.html()).toContain("Choose a folder and a profile, then press Start.");
  expect(view.button("Start").props.disabled).toBe(true);
});

it("asks once on needs_approval, approves, then starts again", async () => {
  const view = harness();
  const approve = vi.spyOn(view.api, "ptyApprove");
  await startClaude(view);
  const first = view.terminal()!;
  expect(first.props.profile).toBe("claude");
  first.props.onError({ code: "needs_approval", detail: "start claude in a terminal" });
  expect(view.terminal()).toBeUndefined();
  expect(view.dialog().props.open).toBe(true);
  expect(view.dialog().props.body).toContain("start claude in a terminal");

  view.dialog().props.onConfirm();
  await tick();
  expect(approve).toHaveBeenCalledWith("claude", null);
  const second = view.terminal()!;
  expect(second.props.id).not.toBe(first.props.id);

  // A second refusal is not asked again.
  second.props.onError({ code: "needs_approval", detail: "still" });
  expect(view.dialog().props.open).toBe(false);
  expect(view.html()).toContain(translate("en", "error.needs_approval"));
});

it("shows the exit code of its own terminal", async () => {
  const view = harness();
  let fire: (e: PtyExit) => void = () => {};
  vi.spyOn(view.api, "onPtyExit").mockImplementation(async (cb) => { fire = cb; return () => {}; });
  view.html();
  hooks.effects[0]();
  await tick();
  await startClaude(view);
  const id = view.terminal()!.props.id as string;
  fire({ id: "other", code: 1 });
  expect(view.html()).not.toContain("Exited");
  fire({ id, code: 3 });
  expect(view.html()).toContain("Exited (code 3)");
});
