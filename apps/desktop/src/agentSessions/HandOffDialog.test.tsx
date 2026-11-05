import type { ReactElement } from "react";
import { Button, RadioGroup, Select } from "@xdev-asia/ui";
import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { defaultHandOff, HandOffView } from "./HandOffDialog";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

const profiles = [{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }];
const worktrees = [{ value: "/a", label: "oak" }, { value: "/b", label: "elm" }];

it("defaults to an agent other than the source, in the source worktree", () => {
  expect(defaultHandOff(profiles, "claude", "/b")).toEqual({ profileId: "codex", worktree: "/b" });
  expect(defaultHandOff([profiles[0]!], "claude", "/a")).toEqual({ profileId: "claude", worktree: "/a" });
});

it("shows an agent picker and a worktree picker, and confirms the choice", () => {
  const onConfirm = vi.fn();
  const onChoice = vi.fn();
  const choice = { profileId: "codex", worktree: "/a" };
  const dialog = HandOffView({ choice, profiles, worktrees, onChoice, onConfirm, onCancel() {} }) as Node;
  const selects = nodes(dialog).filter((n) => n.type === Select);
  expect(selects).toHaveLength(2);
  expect(selects[0]!.props.options).toEqual(profiles);
  expect(selects[1]!.props.options).toEqual(worktrees);
  selects[1]!.props.onChange({ target: { value: "/b" } });
  expect(onChoice).toHaveBeenCalledWith({ profileId: "codex", worktree: "/b" });
  dialog.props.onConfirm();
  expect(onConfirm).toHaveBeenCalledWith(choice);
});

it("the dialog offers exactly one primary button (its confirm)", () => {
  const dialog = HandOffView({ choice: { profileId: "codex", worktree: "/a" }, profiles, worktrees, onChoice() {}, onConfirm() {}, onCancel() {} }) as Node;
  expect(dialog.props.confirmLabel).toBe("Hand off");
  expect(nodes(dialog).filter((n) => n.type === Button && n.props.variant === "primary")).toHaveLength(0);
});

it("offers Focused summary or Full transcript only when the choice carries content", () => {
  const onChoice = vi.fn();
  const none = HandOffView({ choice: { profileId: "codex", worktree: "/a" }, profiles, worktrees, onChoice, onConfirm() {}, onCancel() {} }) as Node;
  expect(nodes(none).filter((n) => n.type === RadioGroup)).toHaveLength(0);
  const choice = { profileId: "codex", worktree: "/a", content: "summary" as const };
  const dialog = HandOffView({ choice, profiles, worktrees, onChoice, onConfirm() {}, onCancel() {} }) as Node;
  const radios = nodes(dialog).filter((n) => n.type === RadioGroup);
  expect(radios).toHaveLength(1);
  expect(radios[0]!.props.value).toBe("summary");
  expect((radios[0]!.props.options as { label: string }[]).map((o) => o.label)).toEqual(["Focused summary", "Full transcript"]);
  radios[0]!.props.onChange("full");
  expect(onChoice).toHaveBeenCalledWith({ ...choice, content: "full" });
});
