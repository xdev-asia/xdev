import { beforeEach, expect, it, vi } from "vitest";
import { SaveBar, SettingsShell } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { hooks, mount, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { SurfaceBoundary } from "@/components/SurfaceBoundary";
import { AgentsPage } from "./agents/AgentsPage";
import { GeneralPage } from "./GeneralPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { GROUPS, SECTIONS } from "./sections";
import { SettingsView } from "./SettingsView";
import { TerminalPage } from "./TerminalPage";
import { VaultsSettings } from "./VaultsSettings";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string) => translate("en", key);

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
});

function view(initial?: string, target?: string, openTerminal?: () => string | null) {
  const api = createMockApi({});
  const onChanged = vi.fn();
  const m = mount(SettingsView, () => ({ api, onChanged, initial, target, openTerminal }));
  const shell = () => m.all().find((n) => n.type === SettingsShell)!;
  const groups = () => shell().props.groups as { id: string; label: string; items: { id: string; label: string; keywords: string[] }[] }[];
  const page = () => m.all().find((n) => SECTIONS.some((s) => s.Component === n.type)) as Node;
  const section = () => m.all().find((n) => n.type === "section" && n.props.className === "settings-section")!;
  const choose = (id: string) => shell().props.onChange(id);
  const query = (q: string) => shell().props.onQuery(q);
  // The SaveBar rides in the shell's `saveBar` slot.
  const bar = () => (shell().props.saveBar ?? undefined) as Node | undefined;
  return { api, onChanged, m, shell, groups, page, section, choose, query, bar };
}

it("opens General first and switches to Vaults", () => {
  const v = view();
  expect(SECTIONS.map((s) => s.id)).toEqual(["general", "repos", "git", "terminal", "editor", "code", "openIn", "browser", "agents", "orchestration", "automations", "usage", "appearance", "notifications", "keys", "qcmd", "capture", "voice", "account", "vaults", "ssh", "hosts", "peers", "mcp", "cloud", "trackers", "cli", "advanced", "diagnostics", "experimental"]);
  expect(v.shell().props.value).toBe("general");
  expect(v.page().type).toBe(GeneralPage);
  expect(v.page().props.api).toBe(v.api);
  expect(v.page().props.onChanged).toBe(v.onChanged);
  v.choose("vaults");
  expect(v.shell().props.value).toBe("vaults");
  expect(v.page().type).toBe(VaultsSettings);
  expect(v.section().props["aria-label"]).toBe(en("settings.vaults.title"));
});

it("an initial section opens that page; an unknown one falls back to the first", () => {
  expect(view("agents").page().type).toBe(AgentsPage);
  hooks.values = [];
  expect(view("vaults").page().type).toBe(VaultsSettings);
  hooks.values = [];
  expect(view("nope").page().type).toBe(GeneralPage);
});

it("every old section id still opens its page (deep links)", () => {
  for (const s of SECTIONS) {
    hooks.values = [];
    expect(view(s.id).page().type, s.id).toBe(s.Component);
  }
});

it("lists notifications and terminal and opens their pages", () => {
  const v = view();
  v.choose("notifications");
  expect(v.page().type).toBe(NotificationsPage);
  v.choose("terminal");
  expect(v.page().type).toBe(TerminalPage);
});

it("passes openTerminal to the section", () => {
  const openTerminal = vi.fn(() => "t1");
  expect(view("agents", undefined, openTerminal).page().props.openTerminal).toBe(openTerminal);
});

// --- groups ---

it("has six groups; every section is in exactly one and each group has a section", () => {
  expect(GROUPS).toHaveLength(6);
  const ids = GROUPS.map((g) => g.id);
  for (const s of SECTIONS) expect(ids.filter((i) => i === s.group), s.id).toHaveLength(1);
  for (const g of GROUPS) expect(SECTIONS.some((s) => s.group === g.id), g.id).toBe(true);
});

it("draws the groups in order, each with its sections as items", () => {
  const g = view().groups();
  expect(g.map((x) => x.label)).toEqual(GROUPS.map((x) => en(x.labelKey)));
  g.forEach((group, i) => {
    expect(group.items.map((it) => it.id)).toEqual(SECTIONS.filter((s) => s.group === GROUPS[i].id).map((s) => s.id));
    expect(group.items.map((it) => it.label)).toEqual(SECTIONS.filter((s) => s.group === GROUPS[i].id).map((s) => en(s.labelKey)));
  });
  expect(g.flatMap((x) => x.items)).toHaveLength(SECTIONS.length);
});

it("gives each item the words of its controls so the shell search finds them", () => {
  const terminal = view().groups().flatMap((x) => x.items).find((it) => it.id === "terminal")!;
  expect(terminal.keywords.some((k) => k.toLowerCase().includes("font"))).toBe(true);
});

// --- search ---

it("the page gets the filter and the active section moves to the best hit when it has none", () => {
  const v = view("agents");
  v.query("branch prefix");
  expect(v.page().props.filter.query).toBe("branch prefix");
  expect(v.page().props.filter.ids.has("git.prefix")).toBe(true);
  expect(v.page().type).not.toBe(AgentsPage);
  expect(v.shell().props.value).toBe(SECTIONS.find((s) => s.Component === v.page().type)!.id);
});

it("keeps the active section when it has a hit", () => {
  const v = view("editor");
  v.query("font");
  expect(v.page().props.filter.ids.has("editor.fontSize")).toBe(true);
  expect(v.page().type).toBe(SECTIONS.find((s) => s.id === "editor")!.Component);
});

it("says so when nothing matches", () => {
  const v = view();
  v.query("zzzzqqq");
  const empty = v.m.all().find((n) => n.props.role === "status" && n.props["data-search"] === "none")!;
  expect(empty.props.children).toBe(translate("en", "settings.search.none", { query: "zzzzqqq" }));
});

it("clearing the query shows the page without a filter again", () => {
  const v = view();
  v.query("font");
  v.query("");
  expect(v.page().props.filter).toBeUndefined();
});

it("a palette target opens its section with the filter holding every id and the target", () => {
  const v = view("git", "git.prefix");
  expect(v.page().props.filter.target).toBe("git.prefix");
  expect(v.page().props.filter.ids.has("git.refresh")).toBe(true);
});

// --- links between sections ---

it("hands a section the way to open another one", () => {
  const v = view();
  v.page().props.openSection("openIn");
  expect(v.shell().props.value).toBe("openIn");
  expect(v.section().props["aria-label"]).toBe(en("openIn.title"));
  hooks.values = [];
  const w = view();
  w.page().props.openSection("nope");
  expect(w.page().type).toBe(GeneralPage);
});

it("a link between sections can carry an arg, and the next link without one drops it", () => {
  const v = view();
  v.page().props.openSection("hosts", "h1");
  expect(v.page().props.arg).toBe("h1");
  v.page().props.openSection("ssh");
  expect(v.page().props.arg).toBeUndefined();
});

it("opening another section clears the query so the section shows", () => {
  const v = view();
  v.query("font");
  v.page().props.openSection("openIn");
  expect(v.shell().props.query).toBe("");
  expect(v.section().props["aria-label"]).toBe(en("openIn.title"));
});

it("contains a page that throws in a boundary reset by the section, so the nav stays", () => {
  const v = view();
  const boundary = () => v.m.all().find((n) => n.type === SurfaceBoundary)!;
  expect(boundary().props).toMatchObject({ id: "page.settings", resetKey: "general", titleKey: "boundary.page.title" });
  v.choose("vaults");
  expect(boundary().props.resetKey).toBe("vaults");
});

// --- save bar ---

it("shows the SaveBar only after the page reports unsaved changes, and drops it on another section", () => {
  const v = view("advanced");
  expect(v.bar()).toBeUndefined();
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  v.page().props.registerSave({ dirty: true, onSave, onDiscard });
  const bar = v.bar()!;
  expect(bar.type).toBe(SaveBar);
  expect(bar.props.dirty).toBe(true);
  expect(bar.props.labels.save).toBe(en("settings.v2.save.save"));
  bar.props.onSave();
  expect(onSave).toHaveBeenCalledTimes(1);
  v.page().props.registerSave({ dirty: false, onSave, onDiscard });
  expect(v.bar()!.props.dirty).toBe(false);
  v.choose("general");
  expect(v.bar()).toBeUndefined();
});

it("asks before leaving a section with unsaved changes", () => {
  const v = view("advanced");
  v.page().props.registerSave({ dirty: true, onSave() {}, onDiscard() {} });
  const confirm = vi.fn(() => false);
  vi.stubGlobal("window", { ...globalThis.window, confirm, addEventListener() {}, removeEventListener() {} });
  v.choose("general");
  expect(confirm).toHaveBeenCalledTimes(1);
  expect(v.shell().props.value).toBe("advanced");
  confirm.mockReturnValue(true);
  v.choose("general");
  expect(v.shell().props.value).toBe("general");
  vi.unstubAllGlobals();
});
