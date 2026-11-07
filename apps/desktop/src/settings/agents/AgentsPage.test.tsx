import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { Banner, Button, IconButton, RadioGroup, StatusDot, Switch, Tag } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { AgentsPage } from "./AgentsPage";
import { watchInstall } from "@/agents/installWatch";
import { ProfileEditor } from "./ProfileEditor";
import { AGENTS_SETTINGS_DEFAULTS } from "@/mockSettings";
import { getToasts, resetToastsForTests } from "@/workspace/toastStore";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
const store = vi.hoisted(() => ({ update: vi.fn(), reload: vi.fn(), view: null }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
    // Slots are bound per draw, so an editor drawn with its own slots keeps them.
    const index = hooks.cursor++;
    const slots = hooks.values;
    if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
    return [slots[index], (value: unknown) => { slots[index] = typeof value === "function" ? value(slots[index]) : value; }];
  };
  return {
    ...react,
    useState: (initial: any) => (hooks.active ? state(initial) : react.useState(initial)),
    useEffect: (effect: any, deps?: any) => (hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, deps)),
    useRef: (initial: any) => {
      if (!hooks.active) return react.useRef(initial);
      const index = hooks.cursor++;
      const slots = hooks.values;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index];
    },
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
vi.mock("@/agents/installWatch", () => ({ watchInstall: vi.fn(async () => () => {}) }));
vi.mock("@/agents/profileStore", async (original) => ({ ...await original<typeof import("@/agents/profileStore")>(), useProfiles: () => store }));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

beforeEach(() => { hooks.values = []; hooks.cursor = 0; hooks.effects = []; hooks.active = false; store.update.mockReset(); });

async function page(setup?: (api: ReturnType<typeof createMockApi>) => Promise<unknown> | void, extra: Partial<Parameters<typeof AgentsPage>[0]> = {}) {
  const api = createMockApi({});
  await setup?.(api);
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AgentsPage({ api, onChanged: vi.fn(), ...extra }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const row = (id: string) => all().find((n) => n.type === "li" && n.props["data-profile"] === id)!;
  const button = (root: Node, label: string) => nodes(root).find((n) => n.type === "button" && n.props.children === label)!;
  const editor = () => all().find((n) => n.type === ProfileEditor);
  return { api, all, row, button, editor };
}

// Draws one editor element as a component of its own, with its own hook slots.
function drawEditor(el: Node) {
  const slots = { values: [] as unknown[] };
  const draw = () => {
    const saved = { values: hooks.values, cursor: hooks.cursor };
    hooks.values = slots.values;
    hooks.cursor = 0;
    hooks.active = true;
    try { return nodes(ProfileEditor(el.props as Parameters<typeof ProfileEditor>[0])); } finally {
      hooks.active = false;
      hooks.values = saved.values;
      hooks.cursor = saved.cursor;
    }
  };
  const field = (name: string) => draw().find((n) => n.props["data-field"] === name)!;
  const type = (name: string, value: string) => field(name).props.onChange({ target: { value } });
  const click = (label: string) => draw().find((n) => n.props.children === label)!.props.onClick();
  return { draw, field, type, click };
}

it("toggling_off_saves_enabled_false", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "profilePut");
  const sw = nodes(p.row("codex")).find((n) => n.props.role === "switch")!;
  expect(sw.props["aria-checked"]).toBe(true);
  sw.props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "codex", enabled: false }));
  expect(store.update).toHaveBeenCalled();
  expect(nodes(p.row("codex")).find((n) => n.props.role === "switch")!.props["aria-checked"]).toBe(false);
});

it("skip_needs_confirm", async () => {
  const p = await page();
  const defaults = vi.spyOn(p.api, "profilesDefaults");
  const seg = p.all().find((n) => n.props.className === "agent-seg")!;
  p.button(seg, en("settings.agents.approvals.skip")).props.onClick();
  expect(defaults).not.toHaveBeenCalled();
  const dialog = () => p.all().find((n) => n.type === ConfirmDialog)!;
  expect(dialog().props.open).toBe(true);
  dialog().props.onConfirm();
  await tick();
  expect(defaults).toHaveBeenCalledWith("skip", expect.any(String), expect.any(String));
  expect(dialog().props.open).toBe(false);
  expect(p.all().some((n) => n.props.className === "agent-skip")).toBe(true);
});

it("editor_parses_env_lines", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "profilePut");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  ed.type("env", "A=1\n\nB = 2");
  ed.click(en("settings.agents.save"));
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "claude", env: [{ name: "A", value: "1" }, { name: "B", value: "2" }] }));
  expect(p.editor()).toBeUndefined();
});

it("editor_rejects_env_line_without_equals", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "profilePut");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  ed.type("env", "A=1\nBROKEN");
  ed.click(en("settings.agents.save"));
  expect(put).not.toHaveBeenCalled();
  expect(ed.draw().find((n) => n.props.role === "alert")!.props.children).toBe(en("error.invalid_profile"));
});

it("reset_calls_profile_reset", async () => {
  const p = await page();
  const reset = vi.spyOn(p.api, "profileReset");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  drawEditor(p.editor()!).click(en("settings.agents.reset"));
  await tick();
  expect(reset).toHaveBeenCalledWith("claude");
  expect(p.editor()).toBeUndefined();
});

it("account_select_lists_only_matching_provider", async () => {
  const p = await page();
  const options = (id: string) => {
    p.button(p.row(id), en("settings.agents.edit")).props.onClick();
    const select = drawEditor(p.editor()!).field("account");
    return nodes(select.props.children).filter((n) => n.type === "option").map((n) => n.props.value);
  };
  expect(options("claude")).toEqual(["", "claude-2", "claude-3", "old"]);
  expect(options("codex")).toEqual(["", "codex-1"]);
});

it("custom_profile_has_no_account_or_permissions", async () => {
  const p = await page();
  p.button(p.all().find((n) => n.props.className === "settings-actions settings-actions-start")!, en("settings.agents.addProfile")).props.onClick();
  const ed = drawEditor(p.editor()!);
  expect(ed.field("account")).toBeUndefined();
  expect(ed.field("permissions")).toBeUndefined();
});

it("status_hooks_switch_saves_hooks_false", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "statusSettingsPut");
  const sw = () => p.all().find((n) => n.props["data-field"] === "hooks")!;
  expect(sw().props.role).toBe("switch");
  expect(sw().props["aria-checked"]).toBe(true);
  expect(p.all().some((n) => n.props.children === en("settings.agents.statusHooks.hint"))).toBe(true);
  sw().props.onClick();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ hooks: false, os: true, sound: true, bell: true, badge: true, volume: 60 }));
  expect(sw().props["aria-checked"]).toBe(false);
  expect((await p.api.statusSettings()).hooks).toBe(false);
});

it("status_hooks_switch_keeps_what_changed_since_load", async () => {
  const p = await page();
  // The Notifications page (or the CLI) wrote since this page loaded.
  const stored = await p.api.statusSettings();
  await p.api.statusSettingsPut({ ...stored, sound: false, hooks: false });
  const put = vi.spyOn(p.api, "statusSettingsPut");
  const sw = () => p.all().find((n) => n.props["data-field"] === "hooks")!;
  sw().props.onClick();
  await tick();
  // The switch read on, so the person asked for off: it stays off, and sound keeps its newer value.
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ hooks: false, sound: false }));
  expect(sw().props["aria-checked"]).toBe(false);
});

it("status_hooks_is_the_last_section", async () => {
  const p = await page();
  const groups = p.all().filter((n) => n.type === "h4" && n.props.className === "settings-group").map((n) => n.props.children);
  expect(groups.at(-1)).toBe(en("settings.agents.statusHooks"));
});

it("account_switch_select_shows_the_stored_policy_and_saves_a_change", async () => {
  const p = await page();
  const field = () => p.all().find((n) => n.props["data-field"] === "accountSwitch")!;
  expect(field().props.value).toBe("ask");
  expect(nodes(field()).filter((n) => n.type === "option").map((n) => n.props.value)).toEqual(["ask", "restart", "keep"]);
  expect(nodes(field()).filter((n) => n.type === "option").map((n) => n.props.children)).toEqual([en("settings.agents.accountSwitch.ask"), en("settings.agents.accountSwitch.restart"), en("settings.agents.accountSwitch.keep")]);
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  field().props.onChange({ target: { value: "keep" } });
  await tick();
  expect(put).toHaveBeenCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, accountSwitch: "keep" });
  expect(field().props.value).toBe("keep");
  expect((await p.api.agentsSettings()).accountSwitch).toBe("keep");
});
it("account_switch_select_puts_nothing_for_the_value_it_already_has", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  p.all().find((n) => n.props["data-field"] === "accountSwitch")!.props.onChange({ target: { value: "ask" } });
  await tick();
  expect(put).not.toHaveBeenCalled();
});
it("account_switch_failed_write_shows_the_error_and_keeps_the_old_value", async () => {
  const p = await page();
  vi.spyOn(p.api, "agentsSettingsPut").mockRejectedValue({ code: "io" });
  p.all().find((n) => n.props["data-field"] === "accountSwitch")!.props.onChange({ target: { value: "restart" } });
  await tick();
  expect(p.all().find((n) => n.props["data-field"] === "accountSwitch")!.props.value).toBe("ask");
  expect(p.all().some((n) => n.props.role === "alert")).toBe(true);
});
it("account_switch_strings_exist_in_both_languages", async () => {
  const en_ = (await import("@/i18n/en.json")).default as Record<string, string>;
  const vi_ = (await import("@/i18n/vi.json")).default as Record<string, string>;
  const keys = Object.keys(en_).filter((k) => k.startsWith("settings.agents.accountSwitch"));
  expect(keys.length).toBeGreaterThanOrEqual(8);
  for (const k of keys) expect(vi_).toHaveProperty(k);
});

it("account_switch_policy_follows_a_settings_change_from_elsewhere", async () => {
  const p = await page();
  // The page's own draw collected two effects now; the second one subscribes.
  expect(p.all().find((n) => n.props["data-field"] === "accountSwitch")!.props.value).toBe("ask");
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, accountSwitch: "restart" });
  await tick();
  expect(p.all().find((n) => n.props["data-field"] === "accountSwitch")!.props.value).toBe("restart");
});

it("keep_awake_radio_shows_the_stored_mode_and_saves_a_change_with_the_other_fields", async () => {
  const p = await page();
  const group = () => p.all().find((n) => n.type === RadioGroup && n.props.name === "keepAwake")!;
  expect(group().props.value).toBe("off");
  expect(group().props.options.map((o: { value: string }) => o.value)).toEqual(["off", "agent", "on"]);
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  group().props.onChange("agent");
  await tick();
  expect(put).toHaveBeenCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, keepAwake: "agent" });
  expect(group().props.value).toBe("agent");
  put.mockClear();
  group().props.onChange("agent");
  await tick();
  expect(put).not.toHaveBeenCalled();
});

it("auto_tab_title_switch_follows_the_stored_flag_and_saves_a_toggle", async () => {
  const p = await page();
  const sw = () => p.all().find((n) => n.type === Switch && n.props["data-field"] === "autoTabTitle")!;
  expect(sw().props.checked).toBe(false);
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  sw().props.onChange({ target: { checked: true } });
  await tick();
  expect(put).toHaveBeenCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, autoTabTitle: true });
  expect(sw().props.checked).toBe(true);
});

it("keep_awake_and_tab_title_strings_exist_in_both_languages", async () => {
  const en_ = (await import("@/i18n/en.json")).default as Record<string, string>;
  const vi_ = (await import("@/i18n/vi.json")).default as Record<string, string>;
  const keys = Object.keys(en_).filter((k) => k.startsWith("settings.agents.keepAwake") || k.startsWith("settings.agents.autoTabTitle"));
  expect(keys.length).toBeGreaterThanOrEqual(8);
  for (const k of keys) expect(vi_).toHaveProperty(k);
});

// Conversation search: off until the person says yes.
const confirm = (p: Awaited<ReturnType<typeof page>>) => p.all().find((n) => n.type === ConfirmDialog && n.props.title === en("sessionSearch.clear.title"))!;
const searchSwitch = (p: Awaited<ReturnType<typeof page>>) => p.all().find((n) => n.props["data-field"] === "sessionSearch")!;

it("session_search_switch_is_off_by_default_and_turning_it_on_puts_the_consent", async () => {
  const p = await page();
  expect(searchSwitch(p).props.checked).toBe(false);
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  searchSwitch(p).props.onChange({ target: { checked: true } });
  await tick();
  expect(put).toHaveBeenCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  expect(searchSwitch(p).props.checked).toBe(true);
});

it("session_search_status_line_shows_the_counts_once_on", async () => {
  const p = await page();
  const line = () => p.all().find((n) => n.props["data-field"] === "sessionSearchStatus");
  expect(line()).toBeUndefined();
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  await tick();
  const status = await p.api.sessionSearchStatus();
  expect(status.updatedAt).not.toBeNull();
  expect(line()!.props.children).toBe(en("sessionSearch.statusAt", { sessions: status.sessions, messages: status.messages, ago: en("ago.now") }));
});

it("session_search_status_line_leaves_out_the_time_before_the_first_update", async () => {
  const p = await page();
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  vi.spyOn(p.api, "sessionSearchStatus").mockResolvedValue({ enabled: true, sessions: 0, messages: 0, updatedAt: null, indexing: false });
  p.all().find((n) => n.props["data-field"] === "sessionSearch")!.props.onChange({ target: { checked: true } });
  await tick();
  expect(p.all().find((n) => n.props["data-field"] === "sessionSearchStatus")!.props.children).toBe(en("sessionSearch.status", { sessions: 0, messages: 0 }));
});

it("session_search_status_is_read_again_while_it_indexes", async () => {
  vi.useFakeTimers();
  try {
    const p = await page();
    await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
    const read = vi.spyOn(p.api, "sessionSearchStatus").mockResolvedValue({ enabled: true, sessions: 0, messages: 0, updatedAt: null, indexing: true });
    p.all().find((n) => n.props["data-field"] === "sessionSearch")!.props.onChange({ target: { checked: true } });
    await tick();
    hooks.effects.length = 0;
    p.all();
    hooks.effects.splice(0).forEach((e) => e());
    await tick();
    const before = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.mock.calls.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});

it("session_search_status_is_read_again_while_the_first_build_has_not_finished", async () => {
  vi.useFakeTimers();
  try {
    const p = await page();
    await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
    const read = vi.spyOn(p.api, "sessionSearchStatus").mockResolvedValue({ enabled: true, sessions: 0, messages: 0, updatedAt: null, indexing: false });
    p.all().find((n) => n.props["data-field"] === "sessionSearch")!.props.onChange({ target: { checked: true } });
    await tick();
    hooks.effects.length = 0;
    p.all();
    hooks.effects.splice(0).forEach((e) => e());
    await tick();
    const before = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(read.mock.calls.length).toBeGreaterThan(before);
  } finally {
    vi.useRealTimers();
  }
});

it("turning_the_search_off_clears_the_index_instead_of_only_saving_the_flag", async () => {
  const p = await page();
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  await tick();
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  const clear = vi.spyOn(p.api, "sessionSearchClear");
  searchSwitch(p).props.onChange({ target: { checked: false } });
  await tick();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(put).not.toHaveBeenCalled();
  expect(searchSwitch(p).props.checked).toBe(false);
});

it("session_search_clear_asks_first_then_clears_toasts_and_reads_off", async () => {
  resetToastsForTests();
  const p = await page();
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  await tick();
  const clear = vi.spyOn(p.api, "sessionSearchClear");
  expect(confirm(p).props.open).toBe(false);
  p.all().find((n) => n.props["data-field"] === "sessionSearchClear")!.props.onClick();
  expect(confirm(p).props.open).toBe(true);
  expect(clear).not.toHaveBeenCalled();
  confirm(p).props.onConfirm();
  await tick();
  expect(clear).toHaveBeenCalledTimes(1);
  expect(getToasts().map((x) => x.text)).toEqual([en("sessionSearch.cleared")]);
  expect(searchSwitch(p).props.checked).toBe(false);
  expect(confirm(p).props.open).toBe(false);
});

it("session_search_clear_failure_shows_the_error_toast", async () => {
  resetToastsForTests();
  const p = await page();
  vi.spyOn(p.api, "sessionSearchClear").mockRejectedValue({ code: "io" });
  confirm(p).props.onConfirm();
  await tick();
  expect(getToasts().map((x) => x.text)).toEqual([en("error.io")]);
  expect(getToasts().map((x) => x.text)).toEqual([en("error.io")]);
});

it("session_search_clear_failure_reads_the_settings_and_status_again", async () => {
  resetToastsForTests();
  const p = await page();
  await p.api.agentsSettingsPut({ ...AGENTS_SETTINGS_DEFAULTS, sessionSearch: true });
  await tick();
  vi.spyOn(p.api, "sessionSearchClear").mockRejectedValue({ code: "io" });
  const settings = vi.spyOn(p.api, "agentsSettings");
  const status = vi.spyOn(p.api, "sessionSearchStatus");
  confirm(p).props.onConfirm();
  await tick();
  expect(settings).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenCalledTimes(1);
});

it("session_search_strings_exist_in_both_languages", async () => {
  const en_ = (await import("@/i18n/en.json")).default as Record<string, string>;
  const vi_ = (await import("@/i18n/vi.json")).default as Record<string, string>;
  const keys = Object.keys(en_).filter((k) => k.startsWith("sessionSearch.") || k.startsWith("settings.agents.sessionSearch"));
  expect(keys.length).toBeGreaterThanOrEqual(8);
  for (const k of keys) expect(vi_).toHaveProperty(k);
});

// Auto sleep: off until the person turns it on; the minutes are held to 1..1440.
const field = (p: Awaited<ReturnType<typeof page>>, name: string) => p.all().find((n) => n.props["data-field"] === name)!;

it("auto_sleep_switch_puts_the_flag_and_the_minutes_field_commits_a_clamped_value", async () => {
  const p = await page();
  expect(field(p, "autoSleep").props.checked).toBe(false);
  expect(field(p, "sleepAfterMin").props.value).toBe("30");
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  field(p, "autoSleep").props.onChange({ target: { checked: true } });
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, autoSleep: true });
  expect(field(p, "autoSleep").props.checked).toBe(true);

  field(p, "sleepAfterMin").props.onChange({ target: { value: "5000" } });
  field(p, "sleepAfterMin").props.onBlur();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ ...AGENTS_SETTINGS_DEFAULTS, autoSleep: true, sleepAfterMin: 1440 });
  expect(field(p, "sleepAfterMin").props.value).toBe("1440");

  // Text that is not a number leaves the setting as it was.
  field(p, "sleepAfterMin").props.onChange({ target: { value: "abc" } });
  field(p, "sleepAfterMin").props.onBlur();
  await tick();
  expect(put).toHaveBeenCalledTimes(2);
  expect(field(p, "sleepAfterMin").props.value).toBe("1440");
});

const rowsIn = (p: Awaited<ReturnType<typeof page>>, section: string) => {
  const list = p.all().find((n) => n.type === "ul" && n.props["data-section"] === section)!;
  return nodes(list.props.children).filter((n) => n.type === "li" && n.props["data-profile"]).map((n) => n.props["data-profile"] as string);
};
const dataField = (p: Awaited<ReturnType<typeof page>>, name: string) => p.all().find((n) => n.props["data-field"] === name);

it("catalog_splits_installed_from_available_with_counts", async () => {
  const p = await page();
  expect(rowsIn(p, "installed")).toEqual(["claude", "codex", "aider"]);
  expect(rowsIn(p, "available")).toHaveLength(17);
  expect(rowsIn(p, "available")).toContain("devin");
  const texts = p.all().map((n) => n.props.children).filter((c) => typeof c === "string");
  expect(texts).toContain(en("settings.agents.catalog.detected", { count: 3 }));
  expect(texts).toContain(en("settings.agents.catalog.count", { count: 17 }));
});

it("refresh_calls_agents_refresh_and_follows_the_new_detection", async () => {
  const p = await page();
  const refresh = vi.spyOn(p.api, "agentsRefresh");
  p.api.__installed = ["claude", "devin"];
  dataField(p, "refresh")!.props.onClick();
  await tick();
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(rowsIn(p, "installed")).toEqual(["claude", "devin"]);
  expect(store.update).toHaveBeenCalled();
});

it("docs_button_says_docs_for_an_installed_agent_and_install_for_a_missing_one_and_opens_the_docs", async () => {
  const p = await page();
  const open = vi.spyOn(p.api, "agentDocsOpen");
  const docs = (id: string) => nodes(p.row(id)).find((n) => n.props["data-field"] === "docs")!;
  expect(docs("aider").type).toBe(IconButton);
  expect(docs("aider").props.icon).toBe("external");
  expect(docs("aider").props.label).toBe(en("settings.agents.catalog.docs"));
  expect(docs("devin").props.label).toBe(en("settings.agents.catalog.install"));
  docs("devin").props.onClick();
  await tick();
  expect(open).toHaveBeenCalledWith("devin");
});

it("a_custom_profile_has_the_custom_tag_and_no_docs_button", async () => {
  const p = await page((api) => api.profilePut({ id: "mine", name: "Mine", cli: null, program: "mine", args: [], env: [], model: null, effort: null, permissions: null, account: null, startup: [], enabled: true }));
  const row = p.row("mine");
  expect(nodes(row).some((n) => n.type === Tag && n.props.children === en("settings.agents.custom"))).toBe(true);
  expect(nodes(row).some((n) => n.props["data-field"] === "docs")).toBe(false);
  expect(nodes(p.row("claude")).some((n) => n.type === Tag)).toBe(false);
});

it("a_builtin_with_its_own_permission_args_shows_the_custom_tag_with_its_hint", async () => {
  const p = await page(async (api) => {
    const view = await api.profiles();
    const claude = view.profiles.find((v) => v.profile.id === "claude")!.profile;
    await api.profilePut({ ...claude, args: ["--permission-mode", "plan"] });
  });
  const tag = nodes(p.row("claude")).find((n) => n.type === Tag && n.props.children === en("settings.agents.perm.custom"));
  expect(tag).toBeDefined();
  expect(dataField(p, "customArgs")!.props.title).toBe(en("settings.agents.perm.customHint"));
  expect(nodes(p.row("codex")).some((n) => n.type === Tag)).toBe(false);
});

it("nothing_installed_shows_the_empty_banner_with_the_blank_terminal_hint", async () => {
  const p = await page((api) => { api.__installed = []; });
  const banner = p.all().find((n) => n.type === Banner)!;
  expect(banner.props.title).toBe(en("settings.agents.catalog.none"));
  expect(rowsIn(p, "installed")).toEqual([]);
});

it("an_installed_custom_profile_hides_the_empty_banner", async () => {
  const p = await page(async (api) => {
    api.__installed = [];
    await api.profilePut({ id: "mine", name: "Mine", cli: null, program: "mine", args: [], env: [], model: null, effort: null, permissions: null, account: null, startup: [], enabled: true });
  });
  expect(p.all().some((n) => n.type === Banner)).toBe(false);
});

it("an_installed_agent_hides_the_empty_banner", async () => {
  const p = await page();
  expect(p.all().some((n) => n.type === Banner)).toBe(false);
});

it("default_agent_lists_auto_and_blank_then_the_agents_and_warns_when_the_saved_one_is_missing", async () => {
  const p = await page(async (api) => { await api.profilesDefaults("ask", "devin", null); });
  const select = dataField(p, "defaultAgent")!;
  const options = nodes(select.props.children).filter((n) => n.type === "option").map((n) => n.props.value);
  expect(options.slice(0, 2)).toEqual(["auto", "blank"]);
  expect(options).toContain("devin");
  expect(select.props.value).toBe("devin");
  // A warning dot with its text, outside the label so it is not the select's name, and linked to it.
  const all = p.all();
  const note = all.find((n) => n.props["data-field"] === "defaultAgentMissing")!;
  expect(nodes(note).find((n) => n.type === StatusDot)!.props).toMatchObject({ state: "waiting", label: en("settings.agents.default.missing") });
  const label = all.find((n) => n.type === "label" && nodes(n.props.children).some((c) => c.props["data-field"] === "defaultAgent"))!;
  expect(nodes(label.props.children)).not.toContain(note);
  expect(select.props["aria-describedby"]).toBe(note.props.id);
  select.props.onChange({ target: { value: "blank" } });
  await tick();
  expect(dataField(p, "defaultAgent")!.props.value).toBe("blank");
  expect(dataField(p, "defaultAgentMissing")).toBeUndefined();
  expect(dataField(p, "defaultAgent")!.props["aria-describedby"]).toBeUndefined();
});

it("a_fresh_default_is_auto", async () => {
  const p = await page();
  expect(dataField(p, "defaultAgent")!.props.value).toBe("auto");
});

it("approvals_has_three_options_and_auto_saves_without_a_confirm", async () => {
  const p = await page();
  const defaults = vi.spyOn(p.api, "profilesDefaults");
  const seg = () => p.all().find((n) => n.props.className === "agent-seg")!;
  const labels = nodes(seg().props.children).filter((n) => n.type === "button").map((n) => n.props.children);
  expect(labels).toEqual([en("settings.agents.approvals.ask"), en("settings.agents.approvals.auto"), en("settings.agents.approvals.skip")]);
  p.button(seg(), en("settings.agents.approvals.auto")).props.onClick();
  await tick();
  expect(defaults).toHaveBeenCalledWith("auto", "auto", expect.any(String));
  expect(p.all().find((n) => n.type === ConfirmDialog)!.props.open).toBe(false);
  expect(p.all().some((n) => n.props.children === en("settings.agents.approvals.autoHint"))).toBe(true);
  p.button(seg(), en("settings.agents.approvals.ask")).props.onClick();
  await tick();
  expect(defaults).toHaveBeenLastCalledWith("ask", "auto", expect.any(String));
});

it("trust_switch_follows_the_stored_flag_and_saves_a_toggle", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "agentsSettingsPut");
  expect(dataField(p, "workspaceTrust")!.props.checked).toBe(true);
  dataField(p, "workspaceTrust")!.props.onChange({ target: { checked: false } });
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ workspaceTrust: false, keepAwake: "off" }));
  expect(dataField(p, "workspaceTrust")!.props.checked).toBe(false);
});

it("catalogue_strings_exist_in_both_languages", () => {
  for (const key of ["catalog.installed", "catalog.detected", "catalog.available", "catalog.count", "catalog.refresh", "catalog.refreshing", "catalog.refreshHint", "catalog.none", "catalog.docs", "catalog.install", "default.auto", "default.blank", "default.missing", "perm.auto", "perm.autoHint", "perm.custom", "perm.customHint", "perm.remove", "approvals.auto", "approvals.autoHint", "trust.title", "trust.what", "custom"]) {
    for (const locale of ["en", "vi"] as const) expect(translate(locale, `settings.agents.${key}`, { count: 1, flag: "f", agent: "a" }), `${locale} ${key}`).not.toBe(`settings.agents.${key}`);
  }
});

it("editor_lists_auto_only_for_an_agent_that_has_it", async () => {
  const p = await page();
  const values = (id: string) => {
    p.button(p.row(id), en("settings.agents.edit")).props.onClick();
    return nodes(drawEditor(p.editor()!).field("permissions").props.children).filter((n) => n.type === "option").map((n) => n.props.value);
  };
  expect(values("claude")).toContain("auto");
  expect(values("aider")).not.toContain("auto");
  expect(values("aider")).toEqual(["", "ask", "skip"]);
});

it("removing_the_flag_tag_sets_ask_and_saves", async () => {
  const p = await page(async (api) => { await api.profilesDefaults("skip", "auto", null); });
  const put = vi.spyOn(p.api, "profilePut");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  const tag = ed.draw().find((n) => n.type === Tag)!;
  expect(tag.props.children).toBe("--dangerously-skip-permissions");
  expect(tag.props.removeLabel).toBe(en("settings.agents.perm.remove", { flag: "--dangerously-skip-permissions", agent: "Claude Code" }));
  tag.props.onRemove();
  expect(ed.field("permissions").props.value).toBe("ask");
  expect(ed.draw().some((n) => n.type === Tag)).toBe(false);
  ed.click(en("settings.agents.save"));
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "claude", permissions: "ask" }));
});

it("the_flag_tag_follows_the_draft_not_the_saved_profile", async () => {
  const p = await page(async (api) => {
    await api.profilesDefaults("skip", "auto", null);
    const claude = (await api.profiles()).profiles.find((v) => v.profile.id === "claude")!.profile;
    await api.profilePut({ ...claude, permissions: "accept-edits" });
  });
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  const tag = () => ed.draw().find((n) => n.type === Tag)?.props.children;
  expect(tag()).toBe("--permission-mode acceptEdits");
  ed.type("permissions", "auto");
  expect(tag()).toBe("--permission-mode auto");
  // Back on Follow, the global Skip applies, not the saved mode.
  ed.type("permissions", "");
  expect(tag()).toBe("--dangerously-skip-permissions");
  // Args of its own stop it following, so it asks.
  ed.type("args", "--verbose");
  expect(tag()).toBeUndefined();
  // A permission flag in the args makes it custom while it is typed.
  ed.type("permissions", "auto");
  ed.type("args", ["--permission-mode", "plan"].join("\n"));
  expect(tag()).toBeUndefined();
  expect(ed.draw().some((n) => n.props.children === en("settings.agents.perm.customHint"))).toBe(true);
});

it("choosing_approve_for_me_shows_what_it_does", async () => {
  const p = await page();
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  const hint = () => ed.draw().find((n) => n.props["data-field"] === "autoHint");
  expect(hint()).toBeUndefined();
  ed.type("permissions", "auto");
  expect(hint()!.props.children).toBe(en("settings.agents.perm.autoHint"));
  ed.type("permissions", "skip");
  expect(hint()).toBeUndefined();
});

it("a_profile_with_its_own_launch_arguments_shows_the_custom_hint_and_no_flag_tag", async () => {
  const p = await page(async (api) => {
    const claude = (await api.profiles()).profiles.find((v) => v.profile.id === "claude")!.profile;
    await api.profilePut({ ...claude, args: ["--permission-mode", "plan"] });
  });
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  expect(ed.draw().some((n) => n.props.children === en("settings.agents.perm.customHint"))).toBe(true);
  expect(ed.draw().some((n) => n.type === Tag)).toBe(false);
});

// --- Opens as ---

it("the_claude_editor_has_an_opens_as_select_with_terminal_and_chat", async () => {
  const p = await page();
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  const options = nodes(ed.field("openAs").props.children).filter((n) => n.type === "option");
  expect(options.map((o) => o.props.children)).toEqual([en("settings.agents.openAs.terminal"), en("settings.agents.openAs.chat")]);
  expect(ed.field("openAsHint").props.children).toBe(en("settings.agents.openAs.hint"));
});

it("a_custom_editor_has_no_opens_as_select", async () => {
  const p = await page();
  p.button(p.all().find((n) => n.props.className === "settings-actions settings-actions-start")!, en("settings.agents.addProfile")).props.onClick();
  const ed = drawEditor(p.editor()!);
  expect(ed.field("openAs")).toBeUndefined();
});

// --- WSL ---

// The claude editor, with these distros and optionally a saved distro.
async function wslEditor(distros: string[], wsl?: string) {
  const p = await page();
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const el = p.editor()!;
  const view = el.props.view;
  const profile = wsl ? { ...view.profile, wsl } : view.profile;
  return drawEditor({ ...el, props: { ...el.props, distros, view: { ...view, profile } } });
}
const optionsOf = (select: Node) => nodes(select.props.children).filter((n) => n.type === "option");

it("wsl_select_is_hidden_without_distros", async () => {
  const ed = await wslEditor([]);
  expect(ed.field("wsl")).toBeUndefined();
  expect(ed.field("account")).toBeDefined();
});

it("wsl_select_lists_windows_and_the_distros", async () => {
  const ed = await wslEditor(["Ubuntu", "Debian"]);
  const options = optionsOf(ed.field("wsl"));
  expect(options.map((n) => n.props.value)).toEqual(["", "Ubuntu", "Debian"]);
  expect(options[0]!.props.children).toBe(en("settings.agents.runInWindows"));
  expect(ed.field("wsl").props.value).toBe("");
});

it("wsl_select_keeps_a_missing_distro", async () => {
  const ed = await wslEditor(["Ubuntu"], "Arch");
  const select = ed.field("wsl");
  expect(select.props.value).toBe("Arch");
  const missing = optionsOf(select).find((n) => n.props.value === "Arch")!;
  expect(missing.props.children).toBe(en("settings.agents.runInMissing", { distro: "Arch" }));
});

it("choosing_a_distro_shows_the_hint_and_hides_the_account", async () => {
  const ed = await wslEditor(["Ubuntu", "Debian"]);
  expect(ed.field("wslHint")).toBeUndefined();
  ed.type("wsl", "Ubuntu");
  expect(ed.field("wslHint").props.children).toBe(en("settings.agents.wslHint", { distro: "Ubuntu" }));
  expect(ed.field("account")).toBeUndefined();
});

it("choosing_a_distro_saves_it", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "profilePut");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const el = p.editor()!;
  const ed = drawEditor({ ...el, props: { ...el.props, distros: ["Ubuntu"] } });
  ed.type("wsl", "Ubuntu");
  ed.click(en("settings.agents.save"));
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "claude", wsl: "Ubuntu" }));
});

it("the_editor_has_one_primary_button", async () => {
  const ed = await wslEditor(["Ubuntu"], "Ubuntu");
  const primary = ed.draw().filter((n) => n.type === Button && (n.props.variant ?? "primary") === "primary");
  expect(primary).toHaveLength(1);
});

it("a_wsl_profile_row_shows_its_distro_not_a_path", async () => {
  const p = await page(async (api) => {
    const claude = (await api.profiles()).profiles.find((v) => v.profile.id === "claude")!.profile;
    await api.profilePut({ ...claude, wsl: "Ubuntu" });
  });
  const row = nodes(p.row("claude"));
  expect(row.some((n) => n.type === Tag && n.props.children === en("settings.agents.wslTag", { distro: "Ubuntu" }))).toBe(true);
  expect(row.some((n) => n.props.className === "ws-mono settings-path")).toBe(false);
  expect(nodes(p.row("codex")).some((n) => n.props.className === "ws-mono settings-path")).toBe(true);
});

it("the_page_passes_the_wsl_distros", async () => {
  const p = await page();
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  expect(p.editor()!.props.distros).toEqual(["Ubuntu"]);
});

it("the_version_check_of_a_wsl_profile_is_unchecked", async () => {
  const api = createMockApi({});
  const claude = (await api.profiles()).profiles.find((v) => v.profile.id === "claude")!.profile;
  await api.profilePut({ ...claude, wsl: "Ubuntu" });
  await expect(api.agentProbe("claude")).rejects.toMatchObject({ code: "wsl_unchecked" });
});

// --- install ---

const installDialog = (all: () => Node[]) => all().find((n) => n.type === ConfirmDialog && n.props.titleId === "agent-install-title")!;

it("a_missing_agent_with_an_install_command_shows_install_and_docs", async () => {
  const p = await page();
  const fields = nodes(p.row("gemini"));
  const install = fields.find((n) => n.props["data-field"] === "install")!;
  expect(install.type).toBe(Button);
  expect(install.props.variant).toBe("secondary");
  expect(install.props.children).toBe(en("settings.agents.install.action"));
  expect(fields.find((n) => n.props["data-field"] === "docs")!.props.label).toBe(en("settings.agents.catalog.docs"));
});

it("a_missing_agent_without_a_command_keeps_the_docs_install_link", async () => {
  const p = await page();
  const fields = nodes(p.row("devin"));
  expect(fields.some((n) => n.props["data-field"] === "install")).toBe(false);
  expect(fields.find((n) => n.props["data-field"] === "docs")!.props.label).toBe(en("settings.agents.catalog.install"));
});

it("installed_and_custom_rows_never_show_install", async () => {
  const p = await page(async (api) => {
    api.__installed = ["gemini"];
    const claude = (await api.profiles()).profiles[0].profile;
    await api.profilePut({ ...claude, id: "mine", name: "mine", cli: null, program: "x" });
  });
  for (const id of ["gemini", "mine"]) expect(nodes(p.row(id)).some((n) => n.props["data-field"] === "install")).toBe(false);
});

it("install_asks_first_and_shows_the_command", async () => {
  const p = await page();
  expect(installDialog(p.all).props.open).toBe(false);
  nodes(p.row("gemini")).find((n) => n.props["data-field"] === "install")!.props.onClick();
  const d = installDialog(p.all);
  expect(d.props.open).toBe(true);
  expect(d.props.title).toBe(en("settings.agents.install.title", { name: "Gemini CLI" }));
  expect(d.props.confirmLabel).toBe(en("settings.agents.install.confirm"));
  expect(nodes(d).some((n) => n.props.children === "npm install -g @example/gemini")).toBe(true);
  d.props.onCancel();
  expect(installDialog(p.all).props.open).toBe(false);
});

it("confirm_opens_a_terminal_with_the_install_profile", async () => {
  const openTerminal = vi.fn(() => "tab1");
  const p = await page(undefined, { openTerminal });
  nodes(p.row("gemini")).find((n) => n.props["data-field"] === "install")!.props.onClick();
  installDialog(p.all).props.onConfirm();
  expect(openTerminal).toHaveBeenCalledWith("xdev:install:gemini", en("settings.agents.install.tab", { name: "Gemini CLI" }));
  expect(installDialog(p.all).props.open).toBe(false);
  expect(watchInstall).toHaveBeenCalledWith(p.api, "tab1", "Gemini CLI", "gemini", store.update);
  expect(p.all().some((n) => n.props.role === "alert")).toBe(false);
});

it("no_open_worktree_shows_the_inline_error", async () => {
  for (const extra of [{ openTerminal: () => null }, {}]) {
    hooks.values = [];
    const p = await page(undefined, extra);
    nodes(p.row("gemini")).find((n) => n.props["data-field"] === "install")!.props.onClick();
    installDialog(p.all).props.onConfirm();
    const alert = p.all().find((n) => n.props.role === "alert")!;
    expect(alert.props.children).toBe(en("settings.agents.install.noWorktree"));
  }
});

it("install_strings_exist_in_both_languages", () => {
  const keys = ["install.action", "install.title", "install.body", "install.confirm", "install.tab", "install.noWorktree", "install.done", "install.notFound", "install.failed"].map((k) => `settings.agents.${k}`);
  keys.push("error.install_none", "error.npm_missing", "error.install_remote");
  for (const key of keys) for (const locale of ["en", "vi"] as const) expect(translate(locale, key), `${locale} ${key}`).not.toBe(key);
});

it("in Settings the view's SaveBar stores the edited profile and Discard closes the editor; the editor has no Save of its own", async () => {
  const registerSave = vi.fn();
  const p = await page(undefined, { registerSave });
  const put = vi.spyOn(p.api, "profilePut");
  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const ed = drawEditor(p.editor()!);
  const settle = () => { hooks.effects.length = 0; ed.draw(); hooks.effects.splice(0).forEach((e) => e()); };
  expect(ed.draw().some((n) => n.props.children === en("settings.agents.save"))).toBe(false);
  settle();
  expect(registerSave).toHaveBeenLastCalledWith(expect.objectContaining({ dirty: false }));

  ed.type("env", "A=1");
  settle();
  const spec = registerSave.mock.lastCall![0] as { dirty: boolean; onSave(): void };
  expect(spec.dirty).toBe(true);
  spec.onSave();
  await tick();
  expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "claude", env: [{ name: "A", value: "1" }] }));
  expect(p.editor()).toBeUndefined();

  p.button(p.row("claude"), en("settings.agents.edit")).props.onClick();
  const again = drawEditor(p.editor()!);
  again.type("env", "B=2");
  hooks.effects.length = 0; again.draw(); hooks.effects.splice(0).forEach((e) => e());
  (registerSave.mock.lastCall![0] as { onDiscard(): void }).onDiscard();
  expect(p.editor()).toBeUndefined();
  expect(put).toHaveBeenCalledTimes(1);
});
