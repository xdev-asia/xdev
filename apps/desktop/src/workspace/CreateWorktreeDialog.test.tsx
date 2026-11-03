import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { CreateWorktreeDialog } from "./CreateWorktreeDialog";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial: unknown) => [initial, () => {}], useRef: () => ({ current: null }), useEffect: () => {} };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string) => translate("en", key) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

function draw(error: string | undefined, onOpenGitSettings?: () => void) {
  const repos = DEMO_WORKSPACE.repos;
  return nodes(
    CreateWorktreeDialog({ repos, repoId: repos[0].id, busy: false, error: error as never, onCreate: vi.fn(), onCancel: vi.fn(), onOpenGitSettings }),
  );
}
const action = (all: Node[]) => all.find((n) => n.type === "button" && n.props.children === translate("en", "workspace.create.openGitSettings"));

it("points a refused branch prefix at Settings → Git", () => {
  const open = vi.fn();
  const all = draw("bad_branch_prefix", open);
  expect(all.find((n) => n.props.role === "alert")?.props.children).toBe(translate("en", "error.bad_branch_prefix"));
  action(all)!.props.onClick();
  expect(open).toHaveBeenCalledOnce();
});

it("offers Settings → Git only for a refused prefix", () => {
  expect(action(draw("branch_exists", vi.fn()))).toBeUndefined();
  expect(action(draw(undefined, vi.fn()))).toBeUndefined();
  expect(action(draw("bad_branch_prefix"))).toBeUndefined();
});
