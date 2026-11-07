import { describe, expect, it, vi } from "vitest";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, LaunchCard } from "@xdev-asia/ui";
import { translate } from "@/i18n";

// The page's state is stubbed so its parts can be read and driven without a DOM.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = initial;
      return [hooks.values[i], (v: unknown) => (hooks.values[i] = v)];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const i = hooks.cursor++;
      if (!(i in hooks.values)) hooks.values[i] = { current: initial };
      return hooks.values[i];
    },
  };
});
vi.mock("@/i18n", async (original) => ({ ...(await original<typeof import("@/i18n")>()), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

import { NewTabPage } from "./NewTabPage";

type Node = ReactElement<Record<string, any>>;
const nodes = (value: unknown): Node[] => {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
};
const en = (key: string) => translate("en", key);

function harness(over: Partial<Parameters<typeof NewTabPage>[0]> = {}) {
  hooks.values = [];
  const calls = { start: [] as unknown[][], options: [] as string[], shell: 0 };
  const props: Parameters<typeof NewTabPage>[0] = {
    agents: [
      { id: "claude", name: "Claude", models: ["opus", "sonnet"] },
      { id: "codex", name: "Codex", models: [] },
    ],
    defaultAgent: "codex",
    worktree: { path: "/w/oak", label: "oak" },
    shell: { id: "shell", name: "Shell" },
    onStart: (...a) => void calls.start.push(a),
    onOptions: (a) => void calls.options.push(a),
    onShell: () => void calls.shell++,
    ...over,
  };
  const all = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try {
      return nodes(NewTabPage(props));
    } finally {
      hooks.active = false;
    }
  };
  const card = () => all().find((n) => n.type === LaunchCard)!;
  return { all, card, calls, props };
}

describe("NewTabPage", () => {
  it("starts on the default agent, in this worktree, with the profile's model; Start is the one primary", () => {
    const view = harness();
    expect(view.card().props.value).toEqual({ agent: "codex", worktree: "/w/oak", model: "", prompt: "" });
    expect(view.card().props.worktrees).toEqual([{ value: "/w/oak", label: "oak" }]);
    expect(view.card().props.models).toEqual([{ value: "", label: en("agentLaunch.model.default") }]);
    // The primary button is the bare `btn`; the card's Start is the only one.
    const html = renderToStaticMarkup(createElement(NewTabPage, view.props));
    expect(html.match(/class="btn"/g)).toHaveLength(1);
    expect(html).toContain(`>${en("workspace.newTab.start")}<`);
    const shell = view.all().find((n) => n.type === Button)!;
    expect(shell.props.variant).toBe("secondary");
    shell.props.onClick();
    expect(view.calls.shell).toBe(1);
  });

  it("an agent change drops a model it does not know; Start hands over the model and the trimmed task", () => {
    const view = harness();
    view.card().props.onChange({ agent: "claude", worktree: "/w/oak", model: "", prompt: "" });
    expect(view.card().props.models.map((m: { value: string }) => m.value)).toEqual(["", "opus", "sonnet"]);
    view.card().props.onChange({ agent: "claude", worktree: "/w/oak", model: "opus", prompt: "  Fix it " });
    view.card().props.onStart();
    expect(view.calls.start).toEqual([["claude", "opus", "Fix it"]]);
    view.card().props.onChange({ agent: "codex", worktree: "/w/oak", model: "opus", prompt: "" });
    expect(view.card().props.value.model).toBe("");
    view.card().props.onStart();
    expect(view.calls.start[1]).toEqual(["codex", null, null]);
  });

  it("Shift on the click that presses Start opens the agent's launch options", () => {
    const view = harness();
    const all = view.all();
    all.find((n) => n.props.className === "ws-new-tab-card")!.props.onClickCapture({ shiftKey: true });
    all.find((n) => n.type === LaunchCard)!.props.onStart();
    expect(view.calls.options).toEqual(["codex"]);
    expect(view.calls.start).toEqual([]);
  });

  it("with no agent only the terminal is offered; a default that is gone falls back to the first", () => {
    expect(harness({ agents: [] }).card()).toBeUndefined();
    expect(harness({ defaultAgent: "aider" }).card().props.value.agent).toBe("claude");
    expect(harness({ shell: null }).all().some((n) => n.type === Button)).toBe(false);
  });
});
