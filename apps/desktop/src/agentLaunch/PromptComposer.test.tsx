import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Textarea } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { PromptComposer } from "./PromptComposer";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return index;
  };
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.active) return react.useState(initial);
      const values = hooks.values;
      const index = slot(initial);
      return [values[index], (v: unknown) => { values[index] = typeof v === "function" ? (v as (x: unknown) => unknown)(values[index]) : v; }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.active) return react.useRef(initial);
      const values = hooks.values;
      const index = slot(() => ({ current: initial }));
      return values[index];
    },
    useEffect: (effect: any, deps?: any) => (hooks.active ? undefined : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const SKILLS = [
  { name: "review", description: "Review the diff" },
  { name: "release", description: "Cut a release" },
  { name: "deploy", description: "Ship it" },
];

function composer(init: { skills?: typeof SKILLS | null; files?: string[] | null } = {}) {
  const state = { value: "" };
  const onNeed = vi.fn();
  const onChange = vi.fn((v: string) => { state.value = v; });
  const values: unknown[] = [];
  const draw = () => {
    hooks.values = values;
    hooks.cursor = 0;
    hooks.active = true;
    try {
      return PromptComposer({ value: state.value, onChange, onNeed, skills: init.skills === undefined ? SKILLS : init.skills, files: init.files === undefined ? [] : init.files });
    } finally {
      hooks.active = false;
    }
  };
  draw();
  const all = () => nodes(draw());
  const area = () => all().find((n) => n.type === Textarea)!;
  const options = () => all().filter((n) => n.props.role === "option");
  const type = (text: string) => {
    state.value = text;
    area().props.onChange({ target: { value: text, selectionStart: text.length } });
  };
  const key = (k: string) => {
    const e = { key: k, preventDefault: vi.fn(), stopPropagation: vi.fn(), nativeEvent: { isComposing: false, stopImmediatePropagation: vi.fn() } };
    area().props.onKeyDown(e);
    return e;
  };
  return { state, onNeed, onChange, area, options, type, key, all };
}

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.active = false; });

it("shows no list until a token starts", () => {
  const c = composer();
  c.type("hello");
  expect(c.options()).toEqual([]);
  expect(c.all().some((n) => n.props.role === "listbox")).toBe(false);
});

it("a slash at a word start lists the matching skills and asks for them", () => {
  const c = composer();
  c.type("/re");
  expect(c.onNeed).toHaveBeenLastCalledWith("skills");
  expect(c.options().map((o) => o.props.id)).toHaveLength(2);
  expect(c.options()[0]!.props["aria-selected"]).toBe(true);
  expect(c.area().props["aria-expanded"]).toBe(true);
});

it("down and up move the highlight, Enter inserts the skill and the keys never reach the dialog", () => {
  const c = composer();
  c.type("run /re");
  const names = () => c.options().map((o) => nodes(o).find((n) => n.props.title)!.props.title.props.children);
  expect(names()).toEqual(["/review", "/release"]);
  const down = c.key("ArrowDown");
  expect(down.preventDefault).toHaveBeenCalled();
  expect(down.stopPropagation).toHaveBeenCalled();
  expect(c.options()[1]!.props["aria-selected"]).toBe(true);
  c.key("ArrowUp");
  expect(c.options()[0]!.props["aria-selected"]).toBe(true);
  c.key("ArrowDown");
  c.key("Enter");
  expect(c.onChange).toHaveBeenLastCalledWith("run /release ");
  expect(c.options()).toEqual([]);
});

it("Tab inserts the highlighted row too", () => {
  const c = composer();
  c.type("/dep");
  c.key("Tab");
  expect(c.onChange).toHaveBeenLastCalledWith("/deploy ");
});

it("Escape closes the list, stops there, and typing opens it again", () => {
  const c = composer();
  c.type("/re");
  const esc = c.key("Escape");
  expect(esc.stopPropagation).toHaveBeenCalled();
  expect(esc.nativeEvent.stopImmediatePropagation).toHaveBeenCalled();
  expect(c.options()).toEqual([]);
  c.type("/rev");
  expect(c.options()).toHaveLength(1);
});

it("without an open list Enter and Escape are left alone", () => {
  const c = composer();
  c.type("plain");
  for (const k of ["Enter", "Escape", "Tab", "ArrowDown"]) expect(c.key(k).preventDefault).not.toHaveBeenCalled();
});

it("with no match Enter and Tab are left alone but Escape closes the list", () => {
  const c = composer();
  c.type("/zzz");
  expect(c.key("Enter").preventDefault).not.toHaveBeenCalled();
  expect(c.key("Tab").preventDefault).not.toHaveBeenCalled();
  expect(c.key("Escape").preventDefault).toHaveBeenCalled();
});

it("an at sign lists the files, 50 at most, and inserts the relative path", () => {
  const files = Array.from({ length: 120 }, (_, i) => `src/file${i}.ts`).concat(["docs/guide.md"]);
  const c = composer({ files });
  c.type("see @");
  expect(c.onNeed).toHaveBeenLastCalledWith("files");
  expect(c.options()).toHaveLength(50);
  c.type("see @guide");
  expect(c.options()).toHaveLength(1);
  c.key("Enter");
  expect(c.onChange).toHaveBeenLastCalledWith("see @docs/guide.md ");
});

it("says it is loading while the list is not there yet", () => {
  const c = composer({ skills: null });
  c.type("/");
  expect(c.options()).toEqual([]);
  expect(c.all().find((n) => n.props.role === "status")?.props.children).toBe(translate("en", "agentLaunch.complete.loading"));
});
