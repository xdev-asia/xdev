import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { Button, NavList, SearchInput } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { DOCS_SEARCH_ID } from "./ids";
import { DocsNav, type DocsNavProps } from "./DocsNav";

const keys = vi.hoisted(() => ({ handlers: {} as Record<string, () => void> }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
vi.mock("@/keys/keymap", () => ({ useKeymap: (h: Record<string, () => void>) => { keys.handlers = h; } }));

type Node = ReactElement<Record<string, any>>;
function find(node: ReactNode, match: (e: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, match, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as Node;
    if (match(el)) out.push(el);
    find(el.props.children, match, out);
  }
  return out;
}
const en = (key: string) => translate("en", key);

function nav(over: Partial<DocsNavProps> = {}) {
  const props: DocsNavProps = {
    sections: ["docs", "changes", "agents"],
    section: "docs",
    onSection: vi.fn(),
    changeCount: null,
    search: { query: "", hits: [], searching: false, error: null, active: 0, onQuery: vi.fn(), onKey: vi.fn() },
    canChangeFolder: true,
    onOpenFolder: vi.fn(),
    vaultNav: <span data-testid="vaults" />,
    children: <span data-testid="list" />,
    ...over,
  };
  const tree = DocsNav(props);
  return { props, tree };
}
const items = (tree: ReactNode) => find(tree, (e) => e.type === NavList)[0].props.items as { id: string; label: string; count?: number }[];

beforeEach(() => {
  keys.handlers = {};
});

it("lists only the sections it is given, docs first", () => {
  expect(items(nav({ sections: ["docs", "agents"] }).tree).map((i) => i.id)).toEqual(["docs", "agents"]);
  expect(items(nav().tree).map((i) => i.label)).toEqual([en("apps.docs"), en("apps.changes"), en("apps.agents")]);
});

it("selects a section through the list", () => {
  const { props, tree } = nav();
  (find(tree, (e) => e.type === NavList)[0].props.onSelect as (id: string) => void)("changes");
  expect(props.onSection).toHaveBeenCalledWith("changes");
});

it("changes shows the count", () => {
  expect(items(nav({ changeCount: 3 }).tree).find((i) => i.id === "changes")?.count).toBe(3);
  expect(items(nav({ changeCount: null }).tree).find((i) => i.id === "changes")?.count).toBeUndefined();
});

it("search field has the docs search id and the active descendant of the active hit", () => {
  const hit = { path: "a.md", title: "A", snippet: "" };
  const { tree } = nav({ search: { query: "a", hits: [hit, hit], searching: false, error: null, active: 1, onQuery: vi.fn(), onKey: vi.fn() } });
  const field = find(tree, (e) => e.type === SearchInput)[0];
  expect(field.props.id).toBe(DOCS_SEARCH_ID);
  expect(field.props["aria-activedescendant"]).toBe("search-results-1");
  expect(field.props["aria-controls"]).toBe("search-results");
  const idle = find(nav().tree, (e) => e.type === SearchInput)[0];
  expect(idle.props["aria-activedescendant"]).toBeUndefined();
});

it("typing and clearing reach the host", () => {
  const { props, tree } = nav();
  const field = find(tree, (e) => e.type === SearchInput)[0];
  field.props.onChange({ target: { value: "x" } });
  field.props.onClear();
  expect(props.search.onQuery).toHaveBeenNthCalledWith(1, "x");
  expect(props.search.onQuery).toHaveBeenNthCalledWith(2, "");
});

it("open folder is disabled while canChangeFolder is false", () => {
  const open = (tree: ReactNode) => find(tree, (e) => e.type === Button && e.props.children === en("docsnav.openFolder"))[0];
  expect(open(nav().tree).props.disabled).toBe(false);
  const blocked = nav({ canChangeFolder: false });
  expect(open(blocked.tree).props.disabled).toBe(true);
  open(nav().tree).props.onClick();
});

it("open folder is one secondary button", () => {
  const { tree } = nav();
  const buttons = find(tree, (e) => e.type === Button);
  expect(buttons).toHaveLength(1);
  expect(buttons[0].props.variant).toBe("secondary");
  expect(buttons[0].props.type).toBe("button");
});

it("draws the sources first and the list last", () => {
  const { tree } = nav();
  const order = find(tree, (e) => e.props["data-testid"] !== undefined || e.type === SearchInput || e.type === NavList).map((e) => e.props["data-testid"] ?? (e.type === SearchInput ? "search" : "sections"));
  expect(order).toEqual(["vaults", "search", "sections", "list"]);
});

it("docs.search focuses and selects the field", () => {
  const field = { focus: vi.fn(), select: vi.fn() };
  vi.stubGlobal("document", { getElementById: (id: string) => (id === DOCS_SEARCH_ID ? field : null) });
  nav();
  keys.handlers["docs.search"]();
  expect(field.focus).toHaveBeenCalled();
  expect(field.select).toHaveBeenCalled();
});
