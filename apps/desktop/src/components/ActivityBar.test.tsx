import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { APPS, type AppId } from "@/shell/apps";
import { ActivityBar } from "./ActivityBar";

// The component is called as a plain function to reach its onClick handlers, so the hook must not need a provider.
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const html = (active: AppId, changeCount: number | null) => renderToStaticMarkup(<ActivityBar active={active} changeCount={changeCount} onSelect={() => {}} />);

describe("ActivityBar", () => {
  it("renders one button per app in order, marking the active one", () => {
    const markup = html("changes", null);
    expect([...markup.matchAll(/data-app="(\w+)"/g)].map((m) => m[1])).toEqual([...APPS]);
    expect(markup.match(/aria-current="page"/g)).toHaveLength(1);
    expect(markup).toMatch(/data-app="changes"[^>]*aria-current="page"/);
  });

  it("leaves hidden apps out", () => {
    const markup = renderToStaticMarkup(<ActivityBar active="docs" changeCount={null} onSelect={() => {}} hidden={["kit", "squads", "nope"]} />);
    expect([...markup.matchAll(/data-app="(\w+)"/g)].map((m) => m[1])).toEqual(["docs", "changes", "tasks", "agents", "accounts", "terminal"]);
  });

  it("shows a badge and count label for pending changes", () => {
    const markup = html("docs", 3);
    expect(markup).toContain('<span class="activity-badge" aria-hidden="true">3</span>');
    expect(markup).toContain('aria-label="Changes, 3 pending"');
  });

  it("caps the badge like the Changes list does", () => {
    const markup = html("docs", 120);
    expect(markup).toContain('<span class="activity-badge" aria-hidden="true">99+</span>');
    expect(markup).toContain('aria-label="Changes, 120 pending"');
  });

  it("shows no badge for 0 or null", () => {
    for (const count of [0, null]) {
      const markup = html("docs", count);
      expect(markup).not.toContain("activity-badge");
      expect(markup).toContain('aria-label="Changes"');
    }
  });

  it("calls onSelect with the clicked app", () => {
    const onSelect = vi.fn();
    const tree = ActivityBar({ active: "docs", changeCount: null, onSelect });
    nodes(tree).find((n) => n.props["data-app"] === "accounts")!.props.onClick();
    expect(onSelect).toHaveBeenCalledWith("accounts");
  });
});
