import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { INITIAL_CHECK, type CheckState } from "@/shell/useUpdateCheck";
import { UpdatesView, type UpdatesViewProps } from "./UpdatesSetting";

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(text).join("");
  if (value && typeof value === "object" && "props" in value) return text((value as Node).props.children);
  return "";
}
const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

function view(state: CheckState = INITIAL_CHECK, over: Partial<UpdatesViewProps> = {}) {
  const props: UpdatesViewProps = { version: "0.3.0", state, channel: "stable", busy: false, onCheck: vi.fn(), onRestart: vi.fn(), onChannel: vi.fn(), t, ...over };
  const all = nodes(UpdatesView(props));
  const by = (attr: string, value: string) => all.find((n) => n.props[attr] === value);
  return { props, all, by, status: () => text(by("data-field", "update-status")!.props.children).trim() };
}

it("shows the version and each phase as a line", () => {
  const p = view();
  expect(text(p.by("data-field", "version")!.props.children)).toBe("Current version: 0.3.0");
  expect(p.status()).toBe("Updates are checked on launch and every 6 hours.");
  expect(view({ phase: { kind: "up-to-date" }, restart: "idle" }).status()).toBe("You're on the latest version.");
  expect(view({ phase: { kind: "downloading", version: "0.4.0", percent: 40 }, restart: "idle" }).status()).toContain("Downloading 0.4.0… 40 %");
  expect(view({ phase: { kind: "error", detail: "offline" }, restart: "idle" }).status()).toBe("Update check failed.");
  expect(text(view({ phase: { kind: "error", detail: "offline" }, restart: "idle" }).by("data-field", "update-error-detail")!.props.children)).toBe("offline");
});

it("a check in flight shows a spinner hidden from screen readers and cannot be started again", () => {
  const p = view({ phase: { kind: "checking" }, restart: "idle" });
  const hidden = p.all.find((n) => n.props["aria-hidden"] === "true");
  expect(hidden && nodes(hidden.props.children).some((n) => typeof n.type !== "string" && (n.type as { name?: string }).name === "Spinner")).toBe(true);
  expect(p.all.some((n) => typeof n.type !== "string" && (n.type as { name?: string }).name === "Spinner")).toBe(true);
  expect(p.by("data-act", "update-check")!.props.disabled).toBe(true);
  expect(view().by("data-act", "update-check")!.props.disabled).toBe(false);
});

it("a click checks stable and a Shift-click checks the release candidate", () => {
  const p = view();
  const click = p.by("data-act", "update-check")!.props.onClick as (e: { shiftKey: boolean }) => void;
  click({ shiftKey: false });
  click({ shiftKey: true });
  expect(p.props.onCheck).toHaveBeenNthCalledWith(1, false);
  expect(p.props.onCheck).toHaveBeenNthCalledWith(2, true);
});

it("the one primary button is Restart to update, and only once an update is ready", () => {
  const primaries = (state: CheckState) => view(state).all.filter((n) => n.type === Button);
  expect(primaries(INITIAL_CHECK)).toHaveLength(0);
  expect(primaries({ phase: { kind: "checking" }, restart: "idle" })).toHaveLength(0);
  const ready = view({ phase: { kind: "ready", version: "0.4.0", notes: "Fixes" }, restart: "idle" });
  const buttons = ready.all.filter((n) => n.type === Button);
  expect(buttons).toHaveLength(1);
  expect(text(buttons[0].props.children)).toBe("Restart to update");
  (buttons[0].props.onClick as () => void)();
  expect(ready.props.onRestart).toHaveBeenCalledOnce();
  expect(text(ready.by("data-field", "update-notes")!.props.children)).toContain("Fixes");
});

it("the channel select offers stable and release candidate and reports a pick", () => {
  const p = view(INITIAL_CHECK, { channel: "rc" });
  const select = p.by("data-field", "update-channel")!;
  expect(select.props.value).toBe("rc");
  expect(nodes(select.props.children).map((o) => text(o.props.children)).filter(Boolean)).toEqual(["Stable", "Release candidate"]);
  (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "stable" } });
  expect(p.props.onChannel).toHaveBeenCalledWith("stable");
  expect(view(INITIAL_CHECK, { channel: null }).by("data-field", "update-channel")!.props.disabled).toBe(true);
});
