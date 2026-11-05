import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Popover, SearchPicker } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import type { ReviewBranch } from "@/api";
import { BaseRefField } from "./BaseRefField";

const hooks = vi.hoisted(() => ({ query: "" }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => [typeof initial === "string" ? hooks.query : initial, () => {}],
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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const b = (name: string, remote = false): ReviewBranch => ({ name, remote });

function draw(over: Partial<Parameters<typeof BaseRefField>[0]> = {}, query = "") {
  hooks.query = query;
  const onChange = vi.fn();
  const tree = nodes(BaseRefField({ value: "", baseRef: "main", branches: [b("main"), b("dev"), b("origin/dev", true)], failed: false, onChange, ...over }));
  const popover = tree.find((n) => n.type === Popover)!;
  const trigger = popover.props.trigger({}) as Node;
  const picker = tree.find((n) => n.type === SearchPicker)!;
  return { onChange, trigger, picker, ids: picker.props.items.map((i: { id: string }) => i.id) as string[] };
}

describe("BaseRefField", () => {
  it("shows the project default, with its branch when known", () => {
    expect(draw().trigger.props.children).toBe(en("workspace.create.base.defaultNamed", { branch: "main" }));
    expect(draw({ baseRef: null }).trigger.props.children).toBe(en("workspace.create.base.default"));
  });

  it("shows the picked ref and keeps the trigger a plain button", () => {
    const { trigger } = draw({ value: "origin/dev" });
    expect(trigger.props.children).toBe("origin/dev");
    expect(trigger.props.type).toBe("button");
  });

  it("lists the default first, then the branches", () => {
    expect(draw().ids).toEqual(["default", "b:dev", "b:origin/dev"]);
  });

  it("puts the Use row first when the query matches no name", () => {
    const { ids, picker } = draw({}, "v1.2");
    expect(ids[0]).toBe("typed");
    expect(picker.props.items[0].title).toBe(en("workspace.create.base.useTyped", { ref: "v1.2" }));
  });

  it("picks the default as an empty ref, a branch by name and the typed text", () => {
    const a = draw();
    a.picker.props.onPick("default");
    expect(a.onChange).toHaveBeenCalledWith("");
    a.picker.props.onPick("b:origin/dev");
    expect(a.onChange).toHaveBeenLastCalledWith("origin/dev");
    const c = draw({}, " v1.2 ");
    c.picker.props.onPick("typed");
    expect(c.onChange).toHaveBeenCalledWith("v1.2");
  });

  it("shows loading, empty and failed lines", () => {
    expect(draw({ branches: null }).picker.props.status).toBe(en("workspace.create.base.loading"));
    expect(draw({ branches: [], failed: true }).picker.props.status).toBe(en("workspace.create.base.failed"));
    expect(draw({ baseRef: null, branches: [] }, "zzz").ids).toEqual(["typed"]);
    expect(draw({ branches: [b("main")] }).picker.props.status).toBeUndefined();
  });

  it("shows the empty line when nothing is listed", () => {
    expect(draw({ baseRef: null, branches: [] }, "").picker.props.items).toHaveLength(1);
  });
});
