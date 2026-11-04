import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import { translate } from "@/i18n";
import { loadUsageMode, UsagePopoverView, type UsagePopoverViewProps } from "./UsagePopover";
import { USAGE_MODE_KEY, type UsageRow } from "./usageModel";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
// The view is called as a function to read its handlers, so its refs and effects are stubs.
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), useRef: () => ({ current: null }), useEffect: () => {} }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const now = Date.parse("2026-11-04T10:00:00Z");
const row = (account: string, over: Partial<UsageRow> = {}): UsageRow => ({
  account, provider: "claude", state: "ok", signIn: false,
  windows: [
    { key: "five_hour", label: "5-hour", percent: 12, resetsAt: now + 130 * 60_000 },
    { key: "seven_day", label: "Weekly", percent: 40, resetsAt: now + 3 * 86_400_000 },
  ],
  ...over,
});
const base = (over: Partial<UsagePopoverViewProps> = {}): UsagePopoverViewProps => ({
  rows: [row("claude-2")], mode: "detailed", loading: false, now, readAt: now,
  onMode: vi.fn(), onRefresh: vi.fn(), onOpenDetails: vi.fn(), onManageAccounts: vi.fn(), onClose: vi.fn(), ...over,
});
const html = (over: Partial<UsagePopoverViewProps> = {}) => renderToStaticMarkup(UsagePopoverView(base(over)));

/** Every element in the tree whose `data-action` is `action`. */
function find(node: ReactNode, action: string, out: ReactElement<Record<string, unknown>>[] = []): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) node.forEach((n) => find(n, action, out));
  else if (node && typeof node === "object" && "props" in node) {
    const el = node as ReactElement<Record<string, unknown>>;
    if (el.props["data-action"] === action) out.push(el);
    find(el.props.children as ReactNode, action, out);
  }
  return out;
}
const call = (node: ReactNode, action: string, name: string, ...args: unknown[]) => (find(node, action)[0]!.props[name] as (...a: unknown[]) => void)(...args);

afterEach(() => vi.unstubAllGlobals());

it("detailed: a bar per window with percent and reset label", () => {
  const out = html();
  expect(out.match(/role="meter"/g)).toHaveLength(2);
  expect(out).toMatch(/role="meter"[^>]*aria-valuenow="40"/);
  expect(out).toContain("40%");
  expect(out).toContain(en("usage.popover.reset.hours", { hours: 2, minutes: 10 }));
  expect(out).toContain("Weekly");
  expect(out).not.toMatch(/#[0-9a-f]{3,6}\b|rgb\(/i);
});
it("compact: one line per account with the busiest window", () => {
  const out = html({ mode: "compact", rows: [row("a"), row("b", { windows: [{ key: "five_hour", label: "5-hour", percent: 90, resetsAt: null }], state: "reserve" })] });
  expect(out.match(/role="meter"/g)).toHaveLength(2);
  expect(out).toContain("40%");
  expect(out).toContain("90%");
  expect(out).not.toContain(en("usage.popover.reset.hours", { hours: 2, minutes: 10 }));
  expect(out).toContain('data-state="reserve"');
});
it("a signed-out account shows the sign-in line, which opens the accounts", () => {
  const props = base({ rows: [row("old", { state: "unknown", signIn: true, windows: [] })] });
  const tree = UsagePopoverView(props);
  expect(renderToStaticMarkup(tree)).toContain(en("usage.popover.signIn", { name: "old" }));
  call(tree, "sign-in", "onClick");
  expect(props.onManageAccounts).toHaveBeenCalledTimes(1);
  expect(html({ rows: [row("fine")] })).not.toContain(en("usage.popover.signIn", { name: "fine" }));
});
it("shows an unknown percent as a dash with no bar", () => {
  const out = html({ rows: [row("a", { windows: [{ key: "x", label: "x", percent: null, resetsAt: null }] })] });
  expect(out).not.toContain('role="meter"');
  expect(out).toContain("–");
});
it("loading disables Refresh and shows the spinner; otherwise Refresh calls onRefresh", () => {
  const busy = html({ loading: true });
  expect(busy).toMatch(/data-action="usage-refresh"[^>]*disabled/);
  expect(busy).toContain("ws-usage-spinner");
  const props = base();
  call(UsagePopoverView(props), "usage-refresh", "onClick");
  expect(props.onRefresh).toHaveBeenCalledTimes(1);
  expect(html()).not.toContain("ws-usage-spinner");
});
it("the mode switch, links, Escape and the backdrop call their handlers", () => {
  const props = base();
  const tree = UsagePopoverView(props);
  call(tree, "usage-mode-compact", "onClick");
  expect(props.onMode).toHaveBeenCalledWith("compact");
  call(tree, "usage-details", "onClick");
  expect(props.onOpenDetails).toHaveBeenCalledTimes(1);
  call(tree, "usage-manage", "onClick");
  expect(props.onManageAccounts).toHaveBeenCalledTimes(1);
  call(tree, "usage-backdrop", "onClick");
  expect(props.onClose).toHaveBeenCalledTimes(1);
  const dialog = (tree as ReactElement<{ children: ReactElement<Record<string, unknown>>[] }>).props.children[1]!;
  (dialog.props.onKeyDown as (e: unknown) => void)({ key: "Escape", preventDefault() {} });
  (dialog.props.onKeyDown as (e: unknown) => void)({ key: "a", preventDefault() {} });
  expect(props.onClose).toHaveBeenCalledTimes(2);
  expect(html({ mode: "compact" })).toMatch(/data-action="usage-mode-compact"[^>]*aria-pressed="true"/);
});
it("empty and unreadable states", () => {
  expect(html({ rows: null })).toContain(en("usage.popover.unreadable"));
  expect(html({ rows: null, loading: true })).toContain(en("usage.popover.loading"));
  expect(html({ rows: [] })).toContain(en("usage.popover.empty"));
});
it("the saved mode defaults to detailed", () => {
  expect(loadUsageMode()).toBe("detailed");
  vi.stubGlobal("localStorage", { getItem: (k: string) => (k === USAGE_MODE_KEY ? "compact" : null) });
  expect(loadUsageMode()).toBe("compact");
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); } });
  expect(loadUsageMode()).toBe("detailed");
});

it("Remaining shows 60 % left for 40 % used in the bars and the numbers", () => {
  const out = html({ display: "remaining" });
  expect(out).toMatch(/role="meter"[^>]*aria-valuenow="60"/);
  expect(out).toMatch(/role="meter"[^>]*aria-valuenow="88"/);
  expect(out).toContain("60%");
  expect(out).not.toContain("40%");
  expect(out).toContain(en("usage.stats.left"));
  const compact = html({ display: "remaining", mode: "compact" });
  expect(compact).toMatch(/role="meter"[^>]*aria-valuenow="60"/);
});
