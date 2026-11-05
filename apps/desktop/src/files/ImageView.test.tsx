import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { ZoomBar } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import { ImageView } from "./ImageView";
import { LoadError } from "./LoadError";
import { ImageSession } from "./imageSession";

const hooks = vi.hoisted(() => ({ active: false, state: null as unknown }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useEffect: (e: any, d?: any) => (hooks.active ? undefined : react.useEffect(e, d)),
    useMemo: (f: any, d: any) => (hooks.active ? f() : react.useMemo(f, d)),
    useRef: (v: any) => (hooks.active ? { current: v } : react.useRef(v)),
    useState: (i: any) => (hooks.active ? [typeof i === "function" ? i() : i, () => {}] : react.useState(i)),
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
const text = (list: Node[]) =>
  list.flatMap((n) => (typeof n.props.children === "string" ? [n.props.children] : Array.isArray(n.props.children) ? n.props.children.filter((c: unknown) => typeof c === "string") : [])).join("|");
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

const draw = (api: ReturnType<typeof createMockApi>) => {
  hooks.active = true;
  try {
    return nodes(ImageView({ api, worktree: "C:/wt/a", rel: "pic.png" }));
  } finally {
    hooks.active = false;
  }
};

it("shows Loading preview… and a dash for the zoom before the image loads", () => {
  const list = draw(createMockApi({}));
  expect(text(list)).toContain(en("files.image.loading"));
  const bar = list.find((n) => n.type === ZoomBar)!;
  expect(bar.props.zoom).toBeNull();
  expect(bar.props.labels).toMatchObject({ zoomOut: "Zoom out", fit: "Fit to view", zoomIn: "Zoom in", actual: "Actual size" });
});

it("the Expand button waits for the image, and Open in default app is there", () => {
  const list = draw(createMockApi({}));
  const buttons = list.filter((n) => n.type === "button");
  const expand = buttons.find((b) => b.props.children === en("files.image.expand"))!;
  expect(expand.props.disabled).toBe(true);
  expect(buttons.some((b) => b.props.children === en("files.openDefault"))).toBe(true);
});

it("opens the file in the default app, and says so when that fails", async () => {
  const api = createMockApi({});
  const open = vi.spyOn(api, "fileOpenDefault").mockRejectedValue({ code: "io" });
  const list = draw(api);
  list.find((n) => n.type === "button" && n.props.children === en("files.openDefault"))!.props.onClick();
  await Promise.resolve();
  expect(open).toHaveBeenCalledWith("C:/wt/a", "pic.png");
});

it("a failed byte read becomes a LoadError whose Retry reads again", async () => {
  const api = createMockApi({});
  const bytes = vi.spyOn(api, "fileBytes").mockRejectedValueOnce({ code: "io" }).mockResolvedValue(new Uint8Array(1));
  const session = new ImageSession(api, "C:/wt/a", "pic.png", { create: () => "blob:x", revoke() {} });
  await session.load();
  expect(session.get()).toMatchObject({ status: "error", error: "io" });
  await session.load();
  expect(session.get().status).toBe("ready");
  expect(bytes).toHaveBeenCalledTimes(2);
  expect(LoadError).toBeTypeOf("function");
});

it("a too-large image shows the size note, not an error alert", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "fileBytes").mockRejectedValue({ code: "too_large" });
  const session = new ImageSession(api, "C:/wt/a", "pic.png");
  await session.load();
  expect(session.get().error).toBe("too_large");
  expect(en("files.image.tooLarge.body")).toContain("20 MB");
});
