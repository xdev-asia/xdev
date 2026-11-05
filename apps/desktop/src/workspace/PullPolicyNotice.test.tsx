import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { CodeBlock } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { POLICY_COMMANDS, PULL_POLICY_CODES, PullPolicyNotice } from "./PullPolicyNotice";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string) => translate("en", key);

it("names the policy stops and nothing else", () => {
  expect([...PULL_POLICY_CODES].sort()).toEqual(["pull_diverged", "pull_policy"]);
});

it("shows the title, the tag, the body and three commands with a copy button each", () => {
  const tree = PullPolicyNotice({});
  const html = renderToStaticMarkup(tree);
  expect(html).toContain(en("ship.pullPolicy.title"));
  expect(html).toContain(en("ship.pullPolicy.tag"));
  expect(html).toContain(en("ship.pullPolicy.body"));
  const blocks = nodes(tree).filter((n) => n.type === CodeBlock);
  expect(blocks.map((b) => b.props.code)).toEqual(["git config pull.rebase false", "git config pull.rebase true", "git config pull.ff only"]);
  expect(POLICY_COMMANDS).toHaveLength(3);
  for (const b of blocks) expect(b.props.labels).toEqual({ copy: en("connect.copy"), copied: en("connect.copied") });
  for (const id of ["merge", "rebase", "ffOnly"]) {
    expect(html).toContain(en(`ship.pullPolicy.${id}`));
    expect(html).toContain(en(`ship.pullPolicy.${id}.hint`));
  }
});

it("links to Settings only when it can open them", () => {
  const link = (tree: unknown) => nodes(tree).find((n) => n.type === "button");
  expect(link(PullPolicyNotice({}))).toBeUndefined();
  const onOpenGitSettings = vi.fn();
  const open = link(PullPolicyNotice({ onOpenGitSettings }))!;
  expect(open.props.type).toBe("button");
  expect(open.props.children).toBe(en("ship.pullPolicy.settings"));
  open.props.onClick();
  expect(onOpenGitSettings).toHaveBeenCalledTimes(1);
});
