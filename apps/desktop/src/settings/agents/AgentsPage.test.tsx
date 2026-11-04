import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi } from "@/api";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { translate } from "@/i18n";
import { AgentsPage } from "./AgentsPage";
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
  };
});
vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));
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

async function page() {
  const api = createMockApi({});
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return AgentsPage({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
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
