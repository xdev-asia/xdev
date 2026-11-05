import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { translate } from "@/i18n";
import type { ProfilesView } from "@/api";
import { targetItems } from "./AgentTargetMenu";
import type { Sessions, Tab } from "./sessions";

type Node = ReactElement<Record<string, any>>;
const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const tab = (id: string, profileId: string): Tab => ({ id, profileId, agent: true, status: "idle", client: {} } as unknown as Tab);
const sessions = (tabs: Tab[]) => ({ tabs: () => tabs }) as unknown as Sessions;

it("lists running agent tabs, then a new tab for each profile that is on and installed", () => {
  const view = { profiles: [{ profile: { id: "claude", enabled: true }, installed: true }, { profile: { id: "codex", enabled: false }, installed: true }, { profile: { id: "gemini", enabled: true }, installed: false }], shells: [] } as unknown as ProfilesView;
  const items = targetItems(sessions([tab("a", "claude"), tab("b", "claude")]), "/w", view, t, vi.fn()) as Node[];
  expect(items.map((n) => n.props["data-tab"] ?? `new:${n.props["data-new"]}`)).toEqual(["a", "b", "new:claude"]);
});

it("falls back to a new claude tab while the profiles load, and reports the choice", () => {
  const choose = vi.fn();
  const items = targetItems(sessions([]), "/w", null, t, choose) as Node[];
  expect(items).toHaveLength(1);
  items[0].props.onClick();
  expect(choose).toHaveBeenCalledWith({ profile: "claude" });
});
