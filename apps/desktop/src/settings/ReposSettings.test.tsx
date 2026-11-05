import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "@xdev-asia/ui";
import { createMockApi, type RepoView } from "@/api";
import { onOpenFile } from "@/files/openFile";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE, type MockRepoFile } from "@/mockWorkspace";
import { McpConfigs } from "./McpConfigs";
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

async function view(repoFiles?: Record<string, MockRepoFile>, first: Partial<RepoView> = {}) {
  const api = createMockApi({}, { workspace: { ...structuredClone(DEMO_WORKSPACE), repos: [{ ...structuredClone(DEMO_WORKSPACE.repos[0]), ...first }, other], repoFiles } });
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

// Project identity and GitHub account
const tab = (v: Awaited<ReturnType<typeof view>>, id: string, kind: string) => nodes(v.form(id)).find((n) => n.props["data-icon-tab"] === kind)!;
const button = (v: Awaited<ReturnType<typeof view>>, id: string, attr: string, value?: string) =>
  nodes(v.form(id)).find((n) => n.props[attr] !== undefined && (value === undefined || n.props[attr] === value))!;

it("the Identity group comes first, with colour, icon and GitHub account rows", async () => {
  const v = await view();
  const form = v.form("demo-xdev");
  const rows = nodes(form).filter((n) => typeof n.props.id === "string" && n.props.children !== undefined && n.type !== "form" && String(n.props.id).startsWith("repos."));
  expect(rows.map((n) => n.props.id).slice(0, 4)).toEqual(["repos.color", "repos.icon", "repos.ghAccount", "repos.shortName"]);
  const heads = nodes(form).filter((n) => n.type === "h4").map((n) => n.props.children);
  expect(heads[0]).toBe(en("settings.repos.identity"));
});

it("the colour is a radio group of the presets; a pick sends only the colour", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  const group = nodes(v.form("demo-xdev")).find((n) => n.props.role === "radiogroup" && n.props["aria-label"] === en("settings.repos.identity.color"))!;
  const radios = nodes(group).filter((n) => n.type === "input" && n.props.type === "radio");
  expect(radios.map((n) => n.props.value)).toEqual(["none", "slate", "red", "orange", "yellow", "green", "teal", "violet", "pink"]);
  // The stored colour is the checked one.
  expect(radios.find((n) => n.props.checked)!.props.value).toBe("teal");
  v.pick("demo-xdev", "color", "violet");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { color: "violet" });
  v.pick("demo-xdev", "color", "none");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { color: null });
  expect((await v.api.workspaceList())[0].color).toBeNull();
});

it("a custom hex is typed into its own field; a bad one is refused under the colour", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  v.type("demo-xdev", "colorHex", "#3a7");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { color: "#3a7" });
  expect(v.field("demo-xdev", "colorHex").props.value).toBe("#3a7");
  v.type("demo-xdev", "colorHex", "#3a7f");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "color")?.props.children).toBe(en("settings.repos.identity.badColor"));
  expect(v.field("demo-xdev", "colorHex").props.value).toBe("#3a7f");
  expect((await v.api.workspaceList())[0].color).toBe("#3a7");
});

it("icon tabs: Emoji shows the grid and a free field; Letter clears the icon", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  expect(tab(v, "demo-xdev", "emoji").props["aria-selected"]).toBe(true);
  expect(tab(v, "demo-xdev", "letter").props["aria-selected"]).toBe(false);
  // A grid cell sends that emoji.
  button(v, "demo-xdev", "data-emoji", "🐛").props.onClick();
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { icon: { kind: "emoji", value: "🐛" } });
  // The free field takes any one emoji.
  v.type("demo-xdev", "iconEmoji", "🇻🇳");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { icon: { kind: "emoji", value: "🇻🇳" } });
  // Two emoji are refused by the backend and shown under the icon.
  v.type("demo-xdev", "iconEmoji", "🚀🚀");
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "icon")?.props.children).toBe(en("settings.repos.identity.badIcon"));
  // Letter: the icon goes back to the first letter.
  tab(v, "demo-xdev", "letter").props.onClick();
  expect(tab(v, "demo-xdev", "letter").props["aria-selected"]).toBe(true);
  expect(nodes(v.form("demo-xdev")).some((n) => n.props["data-emoji"] !== undefined)).toBe(false);
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { icon: null });
});

it("Reset clears the colour and the icon in one save", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  button(v, "demo-xdev", "data-identity-reset").props.onClick();
  expect(v.save("demo-xdev").props.disabled).toBe(false);
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { color: null, icon: null });
  // Nothing to reset on a repo with no identity.
  expect(button(v, "demo-xdev", "data-identity-reset").props.disabled).toBe(true);
});

it("the GitHub account select lists the gh logins and the default, and sends the pick", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  const select = v.field("demo-xdev", "ghAccount");
  const options = nodes(select).filter((n) => n.type === "option");
  expect(options.map((n) => n.props.children)).toEqual([en("settings.repos.gh.default"), "work-me · github.com", "me · github.com"]);
  expect(select.props.value).toBe("");
  v.type("demo-xdev", "ghAccount", options[2].props.value);
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { ghAccount: { host: "github.com", user: "me" } });
  v.type("demo-xdev", "ghAccount", "");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { ghAccount: null });
});

it("a bound login that gh no longer holds stays selected and is marked", async () => {
  const v = await view(undefined, { ghAccount: { host: "github.com", user: "gone" } });
  const select = v.field("demo-xdev", "ghAccount");
  const options = nodes(select).filter((n) => n.type === "option");
  expect(options.map((n) => n.props.children)).toContain(en("settings.repos.gh.gone", { user: "gone", host: "github.com" }));
  expect(select.props.value).toBe(options.find((n) => String(n.props.children).startsWith("gone"))!.props.value);
  expect(v.html()).toContain(en("settings.repos.gh.goneNote"));
  // Untouched, nothing is saved for it.
  expect(v.save("demo-xdev").props.disabled).toBe(true);
});

it("Refresh asks gh for the logins again; a failure is a note, not a blocker", async () => {
  const v = await view();
  const logins = vi.spyOn(v.api, "ghLogins");
  button(v, "demo-xdev", "data-gh-refresh").props.onClick();
  await tick();
  expect(logins).toHaveBeenCalledTimes(1);
  logins.mockRejectedValueOnce({ code: "gh_missing" });
  button(v, "demo-xdev", "data-gh-refresh").props.onClick();
  await tick();
  expect(v.html()).toContain(en("settings.repos.gh.unavailable", { error: en("error.gh_missing") }));
  // The select still offers the default.
  expect(nodes(v.field("demo-xdev", "ghAccount")).filter((n) => n.type === "option")).toHaveLength(1);
});

// The issue command
const SAMPLE_TITLE = en("settings.repos.issue.sample.title");

it("the Issue command row follows the identity rows' page order and sends only the local text", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  const ids = nodes(v.form("demo-xdev")).filter((n) => typeof n.props.id === "string" && String(n.props.id).startsWith("repos.")).map((n) => n.props.id);
  expect(ids).toContain("repos.issueCommand");
  const area = v.field("demo-xdev", "localIssueCommand");
  expect(area.type).toBe("textarea");
  expect(area.props.className).toContain("ws-mono");
  v.type("demo-xdev", "localIssueCommand", "Fix #{number}: {title}");
  await v.submit("demo-xdev");
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { localIssueCommand: "Fix #{number}: {title}" });
  expect((await v.api.workspaceList())[0].localIssueCommand).toBe("Fix #{number}: {title}");
});

it("a too large issue command is refused under its own field with its own words", async () => {
  const v = await view();
  v.type("demo-xdev", "localIssueCommand", "x".repeat(64 * 1024 + 1));
  await v.submit("demo-xdev");
  expect(v.error("demo-xdev", "localIssueCommand")?.props.children).toBe(en("settings.repos.issue.tooLarge"));
});

it("variable chips add {name} to the local text, and the preview fills the sample issue", async () => {
  const v = await view();
  const chips = nodes(v.form("demo-xdev")).filter((n) => n.props["data-issue-var"] !== undefined);
  expect(chips.map((n) => n.props["data-issue-var"])).toEqual(["number", "title", "url", "body", "labels", "repo"]);
  v.type("demo-xdev", "localIssueCommand", "Fix #");
  // The chip is found again after the draw, as the page hands its handler the text typed so far.
  nodes(v.form("demo-xdev")).find((n) => n.props["data-issue-var"] === "number")!.props.onClick();
  expect(v.field("demo-xdev", "localIssueCommand").props.value).toBe("Fix #{number}");
  v.type("demo-xdev", "localIssueCommand", "Fix #{number}: {title} {nope}");
  const preview = nodes(v.form("demo-xdev")).find((n) => n.props["data-issue-preview"] !== undefined)!;
  expect(preview.props.children).toBe(`Fix #123: ${SAMPLE_TITLE} {nope}`);
});

it("the shared issue command is read only, with its trust state and a Trust button", async () => {
  const v = await view({ "/demo/xdev": { issueCommand: "Shared {title}" } });
  const html = v.html();
  expect(html).toContain("Shared {title}");
  expect(html).toContain(en("settings.repos.issue.untrusted"));
  // No editor for it.
  expect(nodes(v.form("demo-xdev")).filter((n) => n.type === "textarea").map((n) => n.props.name)).not.toContain("sharedIssueCommand");
  const trust = vi.spyOn(v.api, "repoHookTrust");
  await v.trust("demo-xdev", "issueCommand");
  const hooks = await v.api.repoHooks("/demo/xdev");
  expect(trust).toHaveBeenCalledWith("/demo/xdev", "issueCommand", hooks.issueCommandHash);
  expect(v.html()).toContain(en("settings.repos.issue.trusted"));
  expect(nodes(v.form("demo-xdev")).some((n) => n.props["data-trust"] === "issueCommand")).toBe(false);
});

it("the preview shows the effective template: local, else trusted shared, else the built-in note", async () => {
  const v = await view({ "/demo/xdev": { issueCommand: "Shared {number}" } });
  const preview = () => nodes(v.form("demo-xdev")).find((n) => n.props["data-issue-preview"] !== undefined)!;
  // Shared but not trusted: nothing of it runs.
  expect(v.html()).toContain(en("settings.repos.issue.previewBuiltIn"));
  await v.trust("demo-xdev", "issueCommand");
  expect(preview().props.children).toBe("Shared 123");
  v.type("demo-xdev", "localIssueCommand", "Local {number}");
  expect(preview().props.children).toBe("Local 123");
});

it("the repo form has an MCP configs row for that repo's checkout", async () => {
  const v = await view();
  const all = nodes(v.form("demo-xdev"));
  expect(all.some((n) => n.props["id"] === "repos.mcpConfigs")).toBe(true);
  expect(all.find((n) => n.type === McpConfigs)?.props.repoPath).toBe("/demo/xdev");
});

it("sparse presets: lists none, adds one on its own save, refuses a bad one, and removes one", async () => {
  const v = await view();
  const update = vi.spyOn(v.api, "repoUpdate");
  expect(v.html()).toContain(en("settings.repos.presets.none"));
  const add = () => nodes(v.form("demo-xdev")).find((n) => n.props["data-preset-add"])!;
  expect(add().props.disabled).toBe(true);

  // A name with folders that are not usable is refused here, before any save.
  v.type("demo-xdev", "presetName", "Docs");
  v.type("demo-xdev", "presetDirs", "../up");
  add().props.onClick();
  await tick();
  expect(update).not.toHaveBeenCalled();
  expect(v.html()).toContain(en("settings.repos.presets.bad"));

  // A pending short name stays typed and is not sent with the preset.
  v.type("demo-xdev", "shortName", "pending");
  v.type("demo-xdev", "presetDirs", "docs\napps/desktop\n");
  v.field("demo-xdev", "presetName").props.onKeyDown({ key: "Enter", preventDefault() {} });
  await tick();
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { sparsePresets: [{ name: "Docs", dirs: ["docs", "apps/desktop"] }] });
  expect(v.field("demo-xdev", "presetName").props.value).toBe("");
  expect(v.field("demo-xdev", "shortName").props.value).toBe("pending");
  expect(v.onChanged).toHaveBeenCalledTimes(1);
  const row = () => nodes(v.form("demo-xdev")).find((n) => n.props["data-preset"] === "Docs");
  expect(row()).toBeDefined();
  expect(v.html()).toContain("docs, apps/desktop");

  nodes(row()!).find((n) => n.type === "button")!.props.onClick();
  await tick();
  expect(update).toHaveBeenLastCalledWith("demo-xdev", { sparsePresets: [] });
  expect(row()).toBeUndefined();
  expect((await v.api.workspaceList()).find((r) => r.id === "demo-xdev")!.sparsePresets ?? []).toEqual([]);
});
