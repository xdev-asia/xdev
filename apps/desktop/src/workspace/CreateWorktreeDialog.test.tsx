import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { buildCreate, CreateWorktreeDialog } from "./CreateWorktreeDialog";
import { parseItem } from "./workItemInput";

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

const AGENTS = [
  { id: "claude", name: "Claude" },
  { id: "codex", name: "Codex" },
];
const BLANK = { text: "", agent: "claude", defaultAgent: "claude", setDefault: false, parent: "", itemUrl: "", itemKind: "pr" as const };

it("preselects the default agent and lists No agent first", () => {
  const repos = DEMO_WORKSPACE.repos;
  const all = nodes(CreateWorktreeDialog({ repos, repoId: repos[0].id, agents: AGENTS, defaultAgent: "claude", onCreate: vi.fn(), onCancel: vi.fn() }));
  const select = all.find((n) => n.type === "select" && n.props.value === "claude")!;
  expect(select).toBeDefined();
  const options = nodes(select.props.children).filter((n) => n.type === "option");
  expect(options.map((o) => o.props.value)).toEqual(["", "claude", "codex"]);
});

it("sends the picked agent and Set as default only when it differs from the default", () => {
  expect(buildCreate({ ...BLANK, agent: "codex", setDefault: true })?.extra).toMatchObject({ agent: "codex", setDefault: true });
  expect(buildCreate({ ...BLANK, agent: "claude", setDefault: true })?.extra).toMatchObject({ agent: "claude", setDefault: false });
  expect(buildCreate({ ...BLANK, agent: "", setDefault: true })?.extra).toMatchObject({ agent: null, setDefault: false });
});

it("sends the parent and the work item", () => {
  const built = buildCreate({ ...BLANK, parent: "/w/oak", itemUrl: "https://x.test/i/7", itemKind: "issue" });
  expect(built?.extra.parent).toBe("/w/oak");
  expect(built?.extra.item).toEqual({ kind: "issue", url: "https://x.test/i/7", title: null });
});

it("refuses a link that is not a URL", () => {
  expect(parseItem("not a link", "pr")).toBe("bad");
  expect(parseItem("ftp://x.test/1", "pr")).toBe("bad");
  expect(buildCreate({ ...BLANK, itemUrl: "nope" })).toBeNull();
  expect(parseItem("  ", "pr")).toBeNull();
});

it("keeps the emoji in the title and uses the code word in the name", () => {
  const built = buildCreate({ ...BLANK, text: "🚀 login" });
  expect(built?.name).toBe("rocket-login");
  expect(built?.extra.title).toBe("🚀 login");
  const plain = buildCreate({ ...BLANK, text: "feat/login" });
  expect(plain?.name).toBe("feat/login");
  expect(plain?.extra.title).toBeNull();
});
