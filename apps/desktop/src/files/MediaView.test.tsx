import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { MediaView } from "./MediaView";

const hooks = vi.hoisted(() => ({ active: false }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (e: any, d?: any) => (hooks.active ? undefined : react.useEffect(e, d)),
    useMemo: (f: any, d: any) => (hooks.active ? f() : react.useMemo(f, d)),
    useSyncExternalStore: (s: any, g: any, sv?: any) => (hooks.active ? g() : react.useSyncExternalStore(s, g, sv)),
  };
});
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const draw = (rel: string, api = createMockApi({})) => {
  hooks.active = true;
  try {
    return nodes(MediaView({ api, worktree: "C:/wt/a", rel }));
  } finally {
    hooks.active = false;
  }
};

it("says it is loading and offers the default app before the bytes arrive", () => {
  const list = draw("a.mp3");
  expect(list.some((n) => n.props.children === translate("en", "files.image.loading"))).toBe(true);
  expect(list.some((n) => n.type === "button" && n.props.children === translate("en", "files.openDefault"))).toBe(true);
});

it("opens the default app, and toasts when that fails", async () => {
  const api = createMockApi({});
  const open = vi.spyOn(api, "fileOpenDefault").mockRejectedValue({ code: "io" });
  draw("a.mp4", api).find((n) => n.type === "button" && n.props.children === translate("en", "files.openDefault"))!.props.onClick();
  await Promise.resolve();
  expect(open).toHaveBeenCalledWith("C:/wt/a", "a.mp4");
});
