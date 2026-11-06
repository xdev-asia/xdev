import { expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Badge, Banner, Button, Checkbox, Segmented } from "@xdev-asia/ui";
import { createMockApi, type Api } from "@/api";
import { translate } from "@/i18n";
import { mount, type Node } from "@/kit/testHooks";
import { TrackersPage } from "./TrackersPage";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const SECRET = "tok-SENTINEL-123";
const field = (all: Node[], name: string) => all.find((n) => n.props["data-field"] === name)!;
const act = (all: Node[], name: string) => all.find((n) => n.props["data-act"] === name)!;
const type = (all: Node[], name: string, value: string) => (field(all, name).props.onChange as (e: unknown) => void)({ target: { value } });

async function open(api: Api = createMockApi({})) {
  const m = mount(TrackersPage as (p: { api: Api; onChanged(): void }) => ReactElement, () => ({ api, onChanged() {} }));
  await m.settle();
  await m.settle();
  return { api, m };
}

it("shows Linear connected and Jira not connected, with a GitHub hint and no token field for GitHub", async () => {
  const { m } = await open();
  const all = m.all();
  expect(all.filter((n) => n.type === Badge).map((b) => b.props.children)).toEqual([en("settings.trackers.connected"), en("settings.trackers.notConnected")]);
  expect(JSON.stringify(all.map((n) => n.props.children))).toContain(en("settings.trackers.github.hint"));
  expect(field(all, "linear-token")).toBeUndefined();
  expect(act(all, "disconnect-linear")).toBeDefined();
  expect(field(all, "jira-site")).toBeDefined();
});

it("keeps the last of Assigned and Created checked and calls trackerPullsSet", async () => {
  const { api, m } = await open();
  const set = vi.spyOn(api, "trackerPullsSet");
  const boxes = m.all().filter((n) => n.type === Checkbox && n.props.label !== undefined);
  const assigned = boxes.find((b) => b.props.label === en("settings.trackers.pulls.assigned") && b.props.checked && b.props.disabled)!;
  expect(assigned).toBeDefined();
  const done = m.all().filter((n) => n.type === Checkbox).find((b) => b.props.label === en("settings.trackers.pulls.done") && !b.props.checked)!;
  (done.props.onChange as (e: unknown) => void)({ target: { checked: true } });
  await m.settle();
  expect(set).toHaveBeenCalledWith("linear", { assigned: true, created: false, done: true });
});

it("disconnect calls trackerDisconnect and flips the badge", async () => {
  const { api, m } = await open();
  const off = vi.spyOn(api, "trackerDisconnect");
  (act(m.all(), "disconnect-linear").props.onClick as () => void)();
  await m.settle();
  expect(off).toHaveBeenCalledWith("linear");
  expect(m.all().filter((n) => n.type === Badge).map((b) => b.props.children)).toEqual(Array(2).fill(en("settings.trackers.notConnected")));
  expect(field(m.all(), "linear-token")).toBeDefined();
});

it("connect sends the Linear token, clears the draft and leaves no trace of it", async () => {
  const { api, m } = await open();
  await (act(m.all(), "disconnect-linear").props.onClick as () => Promise<void>)();
  await m.settle();
  const connect = vi.spyOn(api, "trackerConnect");
  expect(act(m.all(), "connect-linear").props.disabled).toBe(true);
  type(m.all(), "linear-token", SECRET);
  await m.settle();
  expect(act(m.all(), "connect-linear").props.disabled).toBe(false);
  (act(m.all(), "connect-linear").props.onClick as () => void)();
  await m.settle();
  expect(connect).toHaveBeenCalledWith({ kind: "linear", url: "", email: "", token: SECRET });
  const all = m.all();
  expect(JSON.stringify(all.map((n) => [n.props.value, n.props.children, n.props.error]))).not.toContain(SECRET);
  expect(all.filter((n) => n.type === Badge).map((b) => b.props.children)[0]).toBe(en("settings.trackers.connected"));
});

it("a failed Linear connect shows the error on the key field", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "trackerConnect").mockRejectedValue({ code: "tracker_auth" });
  const { m } = await open(api);
  await (act(m.all(), "disconnect-linear").props.onClick as () => Promise<void>)();
  await m.settle();
  type(m.all(), "linear-token", SECRET);
  await m.settle();
  (act(m.all(), "connect-linear").props.onClick as () => void)();
  await m.settle();
  expect(field(m.all(), "linear-token").props.error).toBe(en("error.tracker_auth"));
});

it("Jira has Cloud and Self-hosted fields, and a bad URL lands on the URL field", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "trackerConnect").mockRejectedValue({ code: "tracker_bad_url" });
  const { m } = await open(api);
  const seg = m.all().find((n) => n.type === Segmented)!;
  expect((seg.props.options as { label: string }[]).map((o) => o.label)).toEqual([en("settings.trackers.jira.cloud"), en("settings.trackers.jira.server")]);
  expect(["jira-site", "jira-email", "jira-token"].map((f) => field(m.all(), f) !== undefined)).toEqual([true, true, true]);
  (seg.props.onChange as (v: string) => void)("server");
  await m.settle();
  expect(field(m.all(), "jira-site")).toBeUndefined();
  type(m.all(), "jira-base", "nope");
  type(m.all(), "jira-token", SECRET);
  await m.settle();
  (act(m.all(), "connect-jira").props.onClick as () => void)();
  await m.settle();
  expect(field(m.all(), "jira-base").props.error).toBe(en("error.tracker_bad_url"));
});

it("secret_store shows the keychain banner", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "trackerDisconnect").mockRejectedValue({ code: "secret_store" });
  const { m } = await open(api);
  (act(m.all(), "disconnect-linear").props.onClick as () => void)();
  await m.settle();
  expect(m.all().find((n) => n.type === Banner)!.props.title).toBe(en("error.secret_store"));
});

it("has no primary button", async () => {
  const { m } = await open();
  const buttons = m.all().filter((n) => n.type === Button);
  expect(buttons.length).toBeGreaterThan(0);
  expect(buttons.every((b) => b.props.variant === "secondary")).toBe(true);
  expect(renderToStaticMarkup(<TrackersPage api={createMockApi({})} onChanged={() => {}} />)).not.toContain("btn-primary");
});
