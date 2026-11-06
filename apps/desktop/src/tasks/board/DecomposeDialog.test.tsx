import { Banner, Checkbox, Dialog, Textarea } from "@xdev-asia/ui";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { DecomposeDialog } from "./DecomposeDialog";

// Hooks run against a plain store while `hooks.active`, so the component can be called as a function without a DOM.
const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const slot = (make: () => unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = make();
    return index;
  };
  return {
    ...react,
    useState: (initial: any) => {
      if (!hooks.active) return react.useState(initial);
      const i = slot(() => (typeof initial === "function" ? initial() : initial));
      return [hooks.values[i], (v: unknown) => { hooks.values[i] = typeof v === "function" ? (v as any)(hooks.values[i]) : v; }];
    },
    useReducer: (reducer: any, initial: any) => {
      if (!hooks.active) return react.useReducer(reducer, initial);
      const i = slot(() => initial);
      return [hooks.values[i], (a: unknown) => { hooks.values[i] = reducer(hooks.values[i], a); }];
    },
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const i = slot(() => ({ current: initial }));
      return hooks.values[i];
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
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const REPO = "/repo";

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.active = false; });

function view(api: Pick<Api, "boardDecompose" | "boardCreateMany">) {
  const onWritten = vi.fn();
  const onClose = vi.fn();
  const draw = (): Node => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return DecomposeDialog({ api, repo: REPO, onClose, onWritten }) as Node; } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  return {
    onWritten,
    onClose,
    all,
    dialog: draw,
    goal: async (text: string) => { all().find((n) => n.type === Textarea)!.props.onChange({ target: { value: text } }); await tick(); },
    ask: async () => { draw().props.onConfirm(); await tick(); },
  };
}

it("a goal the agent cannot split shows the banner and stays on the goal step", async () => {
  const api = createMockApi({});
  const v = view(api);
  await v.goal("Ship it !bad");
  expect(v.dialog().type).toBe(Dialog);
  v.dialog().props.onConfirm();
  await new Promise((r) => setTimeout(r, 400));
  const banner = v.all().find((n) => n.type === Banner)!;
  expect(banner.props.title).toBe(translate("en", "board.decompose.bad"));
  expect(v.all().some((n) => n.type === Checkbox)).toBe(false);
});

it("the ask button is disabled while the goal is empty", () => {
  const v = view(createMockApi({}));
  expect(v.dialog().props.confirmDisabled).toBe(true);
});

it("write sends only the checked drafts and none is written before", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "boardCreateMany");
  const v = view(api);
  await v.goal("Build a thing");
  v.dialog().props.onConfirm();
  await new Promise((r) => setTimeout(r, 400));
  const boxes = v.all().filter((n) => n.type === Checkbox);
  expect(boxes).toHaveLength(3);
  expect(create).not.toHaveBeenCalled();
  boxes[1]!.props.onChange({ target: { checked: false } });
  const d = v.dialog();
  expect(d.props.confirmLabel).toBe(translate("en", "board.decompose.write", { count: 2 }));
  d.props.onConfirm();
  await tick();
  expect(create).toHaveBeenCalledTimes(1);
  const [repo, drafts] = create.mock.calls[0]!;
  expect(repo).toBe(REPO);
  expect(drafts.map((x) => x.title)).toEqual(["Write the data model", "Cover it with tests"]);
  expect(v.onWritten).toHaveBeenCalled();
});
