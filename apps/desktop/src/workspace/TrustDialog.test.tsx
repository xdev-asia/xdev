import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev/ui";
import { translate } from "@/i18n";
import { TrustDialog } from "./TrustDialog";

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useRef: () => ({ current: null }), useEffect: () => {} };
});
vi.mock("@/i18n", async (original) => ({
  ...await original<typeof import("@/i18n")>(),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function draw(over: Partial<Parameters<typeof TrustDialog>[0]> = {}) {
  const props = { repo: "xdev", file: "xdev.toml", kind: "setup" as const, text: "pnpm i\nmake", changed: false, busy: false, onTrust: vi.fn(), onCancel: vi.fn(), ...over };
  return { props, all: nodes(TrustDialog(props)) };
}
const button = (all: Node[], label: string) => all.find((n) => (n.type === "button" || n.type === Button) && n.props.children === label)!;
const text = (all: Node[]) => all.flatMap((n) => (typeof n.props.children === "string" ? [n.props.children] : [])).join("\n");

it("shows the exact script text, the repo, the file and what trust covers", () => {
  const { all } = draw();
  expect(all.find((n) => n.type === "pre")?.props.children).toBe("pnpm i\nmake");
  const shown = text(all);
  expect(shown).toContain("xdev");
  expect(shown).toContain("xdev.toml");
  expect(shown).toContain(en("setup.trust.note"));
});

it("Trust and run trusts; Cancel only cancels", () => {
  const { all, props } = draw();
  button(all, en("setup.trust.confirm")).props.onClick();
  expect(props.onTrust).toHaveBeenCalledOnce();
  expect(props.onCancel).not.toHaveBeenCalled();
  button(all, en("dialog.cancel")).props.onClick();
  expect(props.onCancel).toHaveBeenCalledOnce();
});

it("says so when it reopens with changed text, and stays usable while busy only for Cancel", () => {
  expect(text(draw({ changed: true }).all)).toContain(en("setup.trust.changed"));
  expect(text(draw().all)).not.toContain(en("setup.trust.changed"));
  const busy = draw({ busy: true }).all;
  expect(button(busy, en("setup.trust.confirm")).props.disabled).toBe(true);
  expect(button(busy, en("dialog.cancel")).props.disabled).toBeFalsy();
});

it("a failure shows its message", () => {
  expect(text(draw({ error: "hook_untrusted" }).all)).toContain(en("error.hook_untrusted"));
});

it("uses the commands wording for xdev.toml quick commands", () => {
  const { all } = draw({ kind: "commands", text: "Lint\n  pnpm lint" });
  const shown = text(all);
  expect(shown).toContain(en("qcmd.trust.title", { repo: "xdev" }));
  expect(button(all, en("qcmd.trust.confirm"))).toBeDefined();
});
