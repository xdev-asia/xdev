import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Dialog } from "@xdev-asia/ui";
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
  const props: UpdatesViewProps = {
    version: "0.3.0",
    state,
    channel: "stable",
    delay: 0,
    deferral: null,
    builds: { kind: "closed" },
    buildFailed: null,
    confirm: null,
    busy: false,
    onCheck: vi.fn(),
    onRestart: vi.fn(),
    onChannel: vi.fn(),
    onDelay: vi.fn(),
    onBuilds: vi.fn(),
    onPick: vi.fn(),
    onConfirm: vi.fn(),
    onCancelConfirm: vi.fn(),
    date: (iso) => iso.slice(0, 10),
    t,
    ...over,
  };
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

it("the delay select offers 0, 1, 3 and 7 days and reports a number", () => {
  const p = view(INITIAL_CHECK, { delay: 3 });
  const select = p.by("data-field", "update-delay")!;
  expect(select.props.value).toBe(3);
  expect(nodes(select.props.children).map((o) => text(o.props.children)).filter(Boolean)).toEqual(["Offer at once", "1 day after release", "3 days after release", "7 days after release"]);
  (select.props.onChange as (e: { target: { value: string } }) => void)({ target: { value: "7" } });
  expect(p.props.onDelay).toHaveBeenCalledWith(7);
  expect(view(INITIAL_CHECK, { delay: null }).by("data-field", "update-delay")!.props.disabled).toBe(true);
});

it("the check hint mentions the delay only when one is set", () => {
  expect(view(INITIAL_CHECK, { delay: 0 }).by("data-field", "update-delay-note")).toBeUndefined();
  expect(text(view(INITIAL_CHECK, { delay: 1 }).by("data-field", "update-delay-note")!.props.children)).toContain("update delay");
});

it("a held back release says when it will be offered, only after a check that found nothing else", () => {
  const deferral = { version: "0.4.0", offerOn: "2026-03-08T10:00:00Z" };
  const upToDate: CheckState = { phase: { kind: "up-to-date" }, restart: "idle" };
  expect(text(view(upToDate, { deferral }).by("data-field", "update-deferred")!.props.children)).toBe("Version 0.4.0 will be offered on 2026-03-08.");
  expect(view(upToDate).by("data-field", "update-deferred")).toBeUndefined();
  expect(view(INITIAL_CHECK, { deferral }).by("data-field", "update-deferred")).toBeUndefined();
});

const BUILDS = [
  { tag: "v0.4.0-rc.1", publishedAt: "2026-03-01T10:00:00Z", prerelease: true, older: false },
  { tag: "v0.2.0", publishedAt: null, prerelease: false, older: true },
];

it("the build picker opens on a click, lists tag, date and tags, and picks a build", () => {
  const closed = view();
  const toggle = closed.by("data-act", "builds-toggle")!;
  expect(text(toggle.props.children)).toBe("Choose a build");
  (toggle.props.onClick as () => void)();
  expect(closed.props.onBuilds).toHaveBeenCalledWith(true);
  expect(closed.by("data-field", "builds-list")).toBeUndefined();

  const open = view(INITIAL_CHECK, { builds: { kind: "loaded", builds: BUILDS } });
  expect(text(open.by("data-act", "builds-toggle")!.props.children)).toBe("Hide builds");
  const rows = nodes(open.by("data-field", "builds-list")!.props.children).filter((n) => n.props.title !== undefined);
  expect(rows.map((r) => [r.props.title, r.props.meta])).toEqual([
    ["v0.4.0-rc.1", "2026-03-01"],
    ["v0.2.0", "Date unknown"],
  ]);
  expect(text(rows[0].props.trailing)).toBe("Prerelease");
  expect(text(rows[1].props.trailing)).toBe("Older");
  (rows[1].props.onClick as () => void)();
  expect(open.props.onPick).toHaveBeenCalledWith(BUILDS[1]);
  // The picker adds no primary button.
  expect(open.all.filter((n) => n.type === Button)).toHaveLength(0);
});

it("a build list that cannot load shows the reason inline with a retry", () => {
  const reasons = { offline: "offline", "rate-limit": "request limit", failed: "Could not load" } as const;
  for (const [reason, word] of Object.entries(reasons)) {
    const p = view(INITIAL_CHECK, { builds: { kind: "error", reason: reason as keyof typeof reasons, detail: null } });
    expect(text(p.by("data-field", "builds-error")!.props.children)).toContain(word);
    (p.by("data-act", "builds-retry")!.props.onClick as () => void)();
    expect(p.props.onBuilds).toHaveBeenCalledWith(true);
  }
  const failed = view(INITIAL_CHECK, { buildFailed: "v0.2.0" });
  expect(text(failed.by("data-field", "build-install-error")!.props.children)).toBe("Could not install v0.2.0. It may have no update manifest.");
});

it("rows are disabled while a check or download runs", () => {
  const builds = { kind: "loaded", builds: BUILDS } as const;
  const rows = (state: CheckState) => nodes(view(state, { builds }).by("data-field", "builds-list")!.props.children).filter((n) => n.props.title !== undefined);
  expect(rows({ phase: { kind: "downloading", version: "0.4.0", percent: null }, restart: "idle" }).every((r) => r.props.disabled)).toBe(true);
  expect(rows(INITIAL_CHECK).some((r) => r.props.disabled)).toBe(false);
});

it("choosing an older build asks first, with a downgrade warning", () => {
  expect(view().all.some((n) => n.type === Dialog)).toBe(false);
  const p = view(INITIAL_CHECK, { confirm: BUILDS[1] });
  const dialog = p.all.find((n) => n.type === Dialog)!;
  expect(dialog.props.alert).toBe(true);
  expect(dialog.props.title).toBe("Install v0.2.0?");
  expect(text(dialog.props.children)).toContain("older than the version you are running");
  expect(dialog.props.confirmLabel).toBe("Install older build");
  (dialog.props.onConfirm as () => void)();
  (dialog.props.onCancel as () => void)();
  expect(p.props.onConfirm).toHaveBeenCalledOnce();
  expect(p.props.onCancelConfirm).toHaveBeenCalledOnce();
});

function channelOptions(p: ReturnType<typeof view>): string[] {
  const select = p.by("data-field", "update-channel")!;
  return nodes(select.props.children)
    .filter((n) => n.type === "option")
    .map((n) => text(n.props.children));
}

it("without Pro the rc channel carries the Pro tag and opens the upsell", () => {
  const onLocked = vi.fn();
  const p = view(INITIAL_CHECK, { proEarly: false, onLocked });
  expect(channelOptions(p)).toEqual([t("settings.general.updates.channel.stable"), `${t("settings.general.updates.channel.rc")} · ${t("pro.tag")}`]);
  const change = p.by("data-field", "update-channel")!.props.onChange as (e: { target: { value: string } }) => void;
  change({ target: { value: "rc" } });
  expect(onLocked).toHaveBeenCalledTimes(1);
  expect(p.props.onChannel).not.toHaveBeenCalled();
  change({ target: { value: "stable" } });
  expect(p.props.onChannel).toHaveBeenCalledWith("stable");
  // A Shift check follows the rc feed, so it asks for Pro too.
  const click = p.by("data-act", "update-check")!.props.onClick as (e: { shiftKey: boolean }) => void;
  click({ shiftKey: true });
  expect(onLocked).toHaveBeenCalledTimes(2);
  expect(p.props.onCheck).not.toHaveBeenCalled();
});

it("a saved rc is grandfathered: no tag and no upsell without Pro", () => {
  const onLocked = vi.fn();
  const p = view(INITIAL_CHECK, { proEarly: false, channel: "rc", onLocked });
  expect(channelOptions(p).join("|")).not.toContain(t("pro.tag"));
  const change = p.by("data-field", "update-channel")!.props.onChange as (e: { target: { value: string } }) => void;
  change({ target: { value: "rc" } });
  expect(onLocked).not.toHaveBeenCalled();
  expect(p.props.onChannel).toHaveBeenCalledWith("rc");
});

it("with Pro the rc channel has no tag", () => {
  const p = view(INITIAL_CHECK, { proEarly: true });
  expect(channelOptions(p).join("|")).not.toContain(t("pro.tag"));
});

it("while the licence is unknown there is no tag, and early builds wait instead of opening the upsell", () => {
  const onLocked = vi.fn();
  const p = view(INITIAL_CHECK, { proEarly: null, onLocked });
  expect(channelOptions(p).join("|")).not.toContain(t("pro.tag"));
  const change = p.by("data-field", "update-channel")!.props.onChange as (e: { target: { value: string } }) => void;
  change({ target: { value: "rc" } });
  const click = p.by("data-act", "update-check")!.props.onClick as (e: { shiftKey: boolean }) => void;
  click({ shiftKey: true });
  expect(onLocked).not.toHaveBeenCalled();
  expect(p.props.onChannel).not.toHaveBeenCalled();
  expect(p.props.onCheck).not.toHaveBeenCalled();
  change({ target: { value: "stable" } });
  expect(p.props.onChannel).toHaveBeenCalledWith("stable");
});
