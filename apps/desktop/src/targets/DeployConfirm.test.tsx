import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Dialog } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { DeployConfirm } from "./DeployConfirm";

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
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

it("is a modal dialog with Run deploy as the one confirm, and shows the exact command", () => {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const tree = DeployConfirm({ preset: { name: "Prod", run: "vercel deploy --prod", confirm: true, source: "detected" }, onConfirm, onCancel });
  expect(tree.type).toBe(Dialog);
  expect(tree.props.modal).toBe(true);
  expect(tree.props.title).toBe(en("targets.deploy.confirm.title", { name: "Prod" }));
  expect(tree.props.confirmLabel).toBe("Run deploy");
  expect(tree.props.cancelLabel).toBe(en("dialog.cancel"));
  expect(nodes(tree).find((n) => n.type === "pre")?.props.children).toBe("vercel deploy --prod");
  tree.props.onConfirm();
  tree.props.onCancel();
  expect(onConfirm).toHaveBeenCalledOnce();
  expect(onCancel).toHaveBeenCalledOnce();
});
