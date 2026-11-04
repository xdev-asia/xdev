import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev-asia/ui";
import { createMockApi, type RepoView } from "@/api";
import { onOpenFile } from "@/files/openFile";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE, type MockRepoFile } from "@/mockWorkspace";
import { ReposSettings } from "./ReposSettings";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    const index = hooks.cursor++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
    return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

const other: RepoView = { ...structuredClone(DEMO_WORKSPACE.repos[0]), id: "demo-tools", shortName: "tools", path: "/demo/tools", worktreeRoot: "/demo/wt", worktrees: [], found: [] };

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; });

async function view(repoFiles?: Record<string, MockRepoFile>) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repos: [structuredClone(DEMO_WORKSPACE.repos[0]), other], repoFiles } });
  const onChanged = vi.fn();
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return ReposSettings({ api, onChanged }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const form = (id: string) => all().find((n) => n.type === "form" && n.key === id)!;
  const field = (id: string, name: string) => nodes(form(id)).find((n) => (n.type === "input" || n.type === "textarea" || n.type === "select") && n.props.name === name)!;
  const type = (id: string, name: string, value: string) => field(id, name).props.onChange({ target: { value } });
  const pick = (id: string, name: string, value: string) => nodes(form(id)).find((n) => n.type === "input" && n.props.name === name && n.props.value === value)!.props.onChange({ target: { value } });
  const trust = async (id: string, kind: string) => { nodes(form(id)).find((n) => n.props["data-trust"] === kind)!.props.onClick(); await tick(); };
  const submit = async (id: string) => { form(id).props.onSubmit({ preventDefault() {} }); await tick(); };
  const error = (id: string, name: string) => all().find((n) => n.props.id === `settings-${id}-${name}-error`);
  const save = (id: string) => nodes(form(id)).find((n) => n.type === Button)!;
  const html = () => renderToStaticMarkup(draw());
  return { api, onChanged, all, form, field, type, pick, trust, submit, error, save, html };
}

it("saves a changed short name and shows short_name_taken inline", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  expect(v.html()).toContain(en("settings.repos.shortNameNote"));
  expect(v.save("demo-xdev").props.disabled).toBe(true);

  v.type("demo-xdev", "shortName", "tools");
  expect(v.save("demo-xdev").props.disabled).toBe(false);
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { shortName: "tools" });
  expect(v.error("demo-xdev", "shortName")?.props.children).toBe(en("error.short_name_taken"));
  expect(v.field("demo-xdev", "shortName").props["aria-invalid"]).toBe(true);
  expect(v.field("demo-xdev", "shortName").props["aria-describedby"]).toBe("settings-demo-xdev-shortName-error");
  expect(v.onChanged).not.toHaveBeenCalled();

  // Only the changed field goes, trimmed.
  v.type("demo-xdev", "shortName", " xd ");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { shortName: "xd" });
  expect(v.error("demo-xdev", "shortName")).toBeUndefined();
  expect(v.field("demo-xdev", "shortName").props.value).toBe("xd");
  expect(v.all().some((n) => n.props.className === "settings-saved")).toBe(true);
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  expect((await v.api.workspaceList()).find((r) => r.id === "demo-xdev")!.shortName).toBe("xd");
});

it("bad_ref shows under base ref and keeps the typed value", async () => {
  const v = await view();
  v.type("demo-xdev", "baseRef", "a..b");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "baseRef")?.props.children).toBe(en("error.bad_ref"));
  expect(v.error("demo-xdev", "shortName")).toBeUndefined();
  expect(v.field("demo-xdev", "baseRef").props.value).toBe("a..b");
  expect((await v.api.workspaceList())[0].baseRef).toBe("main");
});

it("a worktree folder inside the checkout shows the folder rule", async () => {
  const v = await view();
  v.type("demo-xdev", "worktreeRoot", "/demo/xdev/wt");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "worktreeRoot")?.props.children).toBe(en("settings.repos.badRoot"));
});

it("a bad short name shows the naming rule", async () => {
  const v = await view();
  v.type("demo-xdev", "shortName", "Bad Name");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "shortName")?.props.children).toBe(en("settings.repos.badName"));
});

it("each scripts field sends only itself", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  v.pick("demo-xdev", "setupPolicy", "run");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { setupPolicy: "run" });
  v.type("demo-xdev", "scriptSource", "both");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { scriptSource: "both" });
  v.type("demo-xdev", "localSetup", "pnpm i\nmake");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { localSetup: "pnpm i\nmake" });
  v.type("demo-xdev", "localArchive", "make down");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { localArchive: "make down" });
  expect(v.field("demo-xdev", "localSetup").props.className).toContain("ws-mono");
});

it("shows the shared scripts with their trust state and trusts the shown hash", async () => {
  const v = await view({ "/demo/xdev": { setup: "pnpm i", archive: "make down" } });
  const hooks = await v.api.repoHooks("/demo/xdev");
  const text = v.html();
  expect(text).toContain("pnpm i");
  expect(text).toContain(en("settings.repos.scripts.untrusted"));
  const trust = vi.spyOn(v.api, "repoHookTrust");
  await v.trust("demo-xdev", "setup");
  expect(trust).toHaveBeenCalledWith("/demo/xdev", "setup", hooks.setup!.hash);
  expect(v.all().some((n) => n.props["data-trust"] === "setup")).toBe(false);
  expect(v.all().some((n) => n.props["data-trust"] === "archive")).toBe(true);
});

it("shows the parse error of xdev.toml", async () => {
  const v = await view({ "/demo/xdev": { parseError: "line 2: expected '='" } });
  expect(v.html()).toContain("line 2: expected &#x27;=&#x27;");
});

it("Remove from xDev opens the dialog; confirm forgets the repo and tells the window", async () => {
  const v = await view();
  const forget = vi.spyOn(v.api, "repoForget");
  const remove = v.all().find((n) => n.type === "button" && n.props.children === en("settings.repos.remove"))!;
  remove.props.onClick();
  const dialog = v.all().find((n) => n.props.onConfirm && n.props.onCancel)!;
  expect(dialog.props.name).toBe("xdev");
  expect(forget).not.toHaveBeenCalled();
  dialog.props.onConfirm();
  await tick();
  expect(forget).toHaveBeenCalledWith("demo-xdev");
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  expect(v.all().some((n) => n.type === "form" && n.key === "demo-xdev")).toBe(false);
});

it("the Repo file block lists shared paths, tabs, what was left out and unknown keys", async () => {
  const v = await view({
    "/demo/xdev": { shared: ["node_modules", "target"], tabs: [{ title: "dev", color: null, command: "pnpm dev" }], problems: ["worktree.shared[2] \"../x\": `.` and `..` are not allowed"], unknown: ["worktree.foo", "tabs[1].bar"] },
  });
  const html = v.html();
  expect(html).toContain(en("settings.repos.file"));
  expect(html).toContain("node_modules\ntarget");
  expect(html).toContain("dev: pnpm dev");
  expect(html).toContain(en("settings.repos.file.untrusted"));
  expect(html).toContain("not allowed");
  expect(html).toContain("Unknown keys in xdev.toml: worktree.foo, tabs[1].bar");
});

it("the Repo file block says None when the file sets nothing, and is read only", async () => {
  const v = await view();
  const html = v.html();
  expect(html).toContain(en("settings.repos.file.none"));
  expect(html).not.toContain("Unknown keys");
  expect(nodes(v.form("demo-xdev")).some((n) => n.props["data-trust"] === "shared")).toBe(false);
});

it("Open xdev.toml opens it as a file tab of the repo's first worktree", async () => {
  const seen: unknown[] = [];
  const off = onOpenFile((req) => seen.push(req));
  const v = await view();
  nodes(v.form("demo-xdev")).find((n) => n.props["data-open-file"] !== undefined)!.props.onClick();
  off();
  expect(seen).toEqual([{ worktree: DEMO_WORKSPACE.repos[0].worktrees[0].path, rel: "xdev.toml" }]);
});
