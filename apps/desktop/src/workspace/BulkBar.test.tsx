import { expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";
import { translate } from "@/i18n";
import { BulkBar } from "./BulkBar";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string) => translate("en", key);

type Node = ReactElement<{ children?: ReactNode; [k: string]: unknown }>;
const walk = (node: ReactNode): Node[] => {
  if (!node || typeof node !== "object") return [];
  if (Array.isArray(node)) return node.flatMap(walk);
  const el = node as Node;
  return [el, ...walk(el.props?.children)];
};

const bar = (over: Partial<Parameters<typeof BulkBar>[0]> = {}) => {
  const calls = { sleep: vi.fn() };
  const props = { count: 2, allPinned: false, canSleep: true, onArchive() {}, onDelete() {}, onPin() {}, onSleep: calls.sleep, onStatus() {}, onClear() {}, ...over };
  const sleep = walk(BulkBar(props)).find((n) => n.type === "button" && n.props.children === en("sleep.menu"))!;
  return { calls, sleep };
};

it("shows a Sleep button with its hint that calls onSleep", () => {
  const { calls, sleep } = bar();
  expect(sleep).toBeDefined();
  expect(sleep.props.title).toBe(en("bulk.bar.sleep.hint"));
  expect(sleep.props.type).toBe("button");
  expect(sleep.props.disabled).toBe(false);
  (sleep.props.onClick as () => void)();
  expect(calls.sleep).toHaveBeenCalledTimes(1);
});

it("disables Sleep when no selected worktree can sleep", () => {
  expect(bar({ canSleep: false }).sleep.props.disabled).toBe(true);
});
