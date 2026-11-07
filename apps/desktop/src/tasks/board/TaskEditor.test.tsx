import { Banner, Button, Dialog } from "@xdev-asia/ui";
import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api, type TaskFull } from "@/api";
import { translate } from "@/i18n";
import { TaskEditor } from "./TaskEditor";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? undefined : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/agents/profileStore", () => ({ useProfiles: () => ({ view: null, update() {}, reload: async () => {} }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string) => translate("en", key);
const REPO = "/repo";

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.active = false; });

function view(api: Pick<Api, "boardCreate" | "boardUpdate" | "boardGet">, extra: { task?: TaskFull } = {}) {
  const onSaved = vi.fn();
  const onClose = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return TaskEditor({ api, repo: REPO, open: true, onClose, onSaved, ...extra }); } finally { hooks.active = false; }
  };
  const all = () => nodes(draw());
  const named = (name: string) => all().find((n) => n.props.name === name)!;
  const dialog = () => draw() as Node;
  return { onSaved, onClose, all, named, dialog, type: async (name: string, value: string) => { named(name).props.onChange({ target: { value } }); await tick(); } };
}

it("saving a new task calls boardCreate with the form", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "boardCreate");
  const v = view(api);
  expect(v.dialog().type).toBe(Dialog);
  expect(v.dialog().props.title).toBe(en("board.create.title"));
  expect(v.dialog().props.confirmLabel).toBe(en("board.save"));
  await v.type("title", "  Fix the loop ");
  await v.type("labels", "auth, , bug");
  await v.named("priority").props.onChange({ target: { value: "p1" } });
  v.dialog().props.onConfirm();
  await tick();
  expect(create).toHaveBeenCalledWith(REPO, { title: "Fix the loop", status: "backlog", priority: "p1", assignee: undefined, labels: ["auth", "bug"], body: "" });
  expect(v.onSaved).toHaveBeenCalledOnce();
  expect(v.onSaved.mock.calls[0][0].title).toBe("Fix the loop");
});

it("an empty title is not saved", async () => {
  const api = createMockApi({});
  const create = vi.spyOn(api, "boardCreate");
  const v = view(api);
  v.dialog().props.onConfirm();
  await tick();
  expect(create).not.toHaveBeenCalled();
  expect(v.named("title").props.error).toBe(en("board.field.title.required"));
});

it("a draft fills the form", () => {
  const api = createMockApi({});
  const onSaved = vi.fn();
  hooks.cursor = 0;
  hooks.active = true;
  let tree: unknown;
  try { tree = TaskEditor({ api, repo: REPO, open: true, draft: { title: "From a selection", labels: ["x"], body: "From terminal claude" }, onClose() {}, onSaved }); } finally { hooks.active = false; }
  const byName = (n: string) => nodes(tree).find((x) => x.props.name === n)!;
  expect(byName("title").props.value).toBe("From a selection");
  expect(byName("labels").props.value).toBe("x");
  expect(byName("body").props.value).toBe("From terminal claude");
});

it("a conflict shows the banner, Reload loads the new version", async () => {
  const api = createMockApi({});
  const [first] = (await api.boardList(REPO)).tasks;
  const task = await api.boardGet(REPO, first.id);
  api.__boardEditOutside(REPO, first.id, { title: "Changed on disk" });
  const update = vi.spyOn(api, "boardUpdate");
  const v = view(api, { task });
  expect(v.dialog().props.title).toBe(en("board.edit.title"));
  await v.type("title", "My edit");
  v.dialog().props.onConfirm();
  await tick();
  expect(update).toHaveBeenCalledWith(REPO, first.id, expect.objectContaining({ title: "My edit" }), task.task.updated);
  expect(v.onSaved).not.toHaveBeenCalled();
  const banner = v.all().find((n) => n.type === Banner)!;
  expect(banner.props.title).toBe(en("board.err.conflict"));
  const reload = banner.props.action as Node;
  expect(reload.props.type).toBe("button");
  expect(reload.props.children).toBe(en("board.err.reload"));
  expect(v.dialog().props.confirmDisabled).toBe(true);
  reload.props.onClick();
  await tick();
  expect(v.all().some((n) => n.type === Banner)).toBe(false);
  expect(v.named("title").props.value).toBe("Changed on disk");
  v.dialog().props.onConfirm();
  await tick();
  expect(v.onSaved).toHaveBeenCalledOnce();
});

it("the task sheet offers Delete, not as its main action; a new task has none", async () => {
  const api = createMockApi({});
  const [first] = (await api.boardList(REPO)).tasks;
  const task = await api.boardGet(REPO, first.id);
  const onDelete = vi.fn();
  const v = view(api, { task, onDelete } as { task: TaskFull });
  const del = v.all().find((n) => n.props["data-act"] === "delete")!;
  expect(del.type).toBe(Button);
  expect(del.props.children).toBe(en("board.delete"));
  expect(del.props.type).toBe("button");
  expect(del.props.variant).toBe("secondary");
  // The dialog's Save stays the one primary.
  expect(v.dialog().props.confirmLabel).toBe(en("board.save"));
  del.props.onClick();
  expect(onDelete).toHaveBeenCalledExactlyOnceWith(task);
  hooks.values = [];
  const fresh = view(api, { onDelete } as {});
  expect(fresh.all().some((n) => n.props["data-act"] === "delete")).toBe(false);
});
