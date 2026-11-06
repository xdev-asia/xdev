import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { createMockApi, type Api } from "@/api";
import { Button, Select, StatusDot, Switch } from "@xdev-asia/ui";
import { translate } from "@/i18n";
import { CodeIntelPage } from "./CodeIntelPage";

const hooks = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  const state = (initial: unknown) => {
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

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
const text = (value: unknown): string =>
  typeof value === "string" || typeof value === "number" ? String(value) : Array.isArray(value) ? value.map(text).join("") : value && typeof value === "object" && "props" in value ? text((value as Node).props.children) : "";
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  hooks.effects = [];
  hooks.active = false;
});

async function page(api: Api = createMockApi({})) {
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return CodeIntelPage({ api, onChanged: vi.fn() }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const all = () => nodes(draw());
  const row = (language: string) => nodes(all().find((n) => n.props["data-language"] === language));
  const status = (language: string) => row(language).find((n) => n.type === StatusDot)!.props;
  const sw = (language: string) => row(language).find((n) => n.type === Switch)!;
  const master = () => nodes(all().find((n) => n.props["data-setting-id"] === "code.enabled")).find((n) => n.type === Switch)!;
  const button = (label: string) => all().find((n) => n.type === Button && text(n.props.children) === label)!;
  return { api, all, row, status, sw, master, button };
}

it("rows say found, not found and running", async () => {
  const api = createMockApi({});
  await api.lspTrust("/w", true);
  await api.lspOpen("/w", "a.ts", "typescript", 1, "");
  const p = await page(api);
  expect(p.status("typescript")).toMatchObject({ tone: "ok", label: "Found: /usr/local/bin/typescript-language-server" });
  expect(text(p.row("typescript").find((n) => n.props["data-field"] === "running"))).toBe("Running in 1 worktree");
  expect(p.status("python")).toMatchObject({ tone: "neutral", label: "Not found" });
  expect(text(p.row("python").find((n) => n.props["data-field"] === "hint"))).toBe(
    "Install pyright-langserver and make sure it is on your PATH, then select Look again.",
  );
  expect(p.row("rust").some((n) => n.props["data-field"] === "running")).toBe(false);
  expect(p.sw("rust").props["aria-label"]).toBe("Use the Rust server");
  expect(p.all().filter((n) => n.type === Button && n.props.variant !== "secondary")).toEqual([]);
});

it("a language switch puts the language in disabled", async () => {
  const p = await page();
  const put = vi.spyOn(p.api, "lspSettingsPut");
  expect(p.sw("rust").props.checked).toBe(true);
  p.sw("rust").props.onChange();
  await tick();
  expect(put).toHaveBeenCalledWith({ enabled: true, disabled: ["rust"], idleMinutes: 10, trusted: [] });
  expect(p.sw("rust").props.checked).toBe(false);
  p.sw("rust").props.onChange();
  await tick();
  expect(put).toHaveBeenLastCalledWith({ enabled: true, disabled: [], idleMinutes: 10, trusted: [] });
});

it("Look again searches PATH again", async () => {
  const p = await page();
  const servers = vi.spyOn(p.api, "lspServers");
  p.button("Look again").props.onClick();
  await tick();
  expect(servers).toHaveBeenCalledWith(true);
  expect(p.status("typescript").label).toBe("Found: /usr/local/bin/typescript-language-server");
});

it("the master switch off disables the rows and the idle choice", async () => {
  const p = await page();
  p.master().props.onChange();
  await tick();
  expect(p.master().props.checked).toBe(false);
  for (const l of ["typescript", "rust", "python", "go", "csharp"]) expect(p.sw(l).props.disabled, l).toBe(true);
  expect(p.all().find((n) => n.type === Select)!.props.disabled).toBe(true);
});

it("the idle choice and forgetting trusted repos are written", async () => {
  const api = createMockApi({});
  await api.lspTrust("/a", true);
  await api.lspTrust("/b", true);
  const p = await page(api);
  const select = () => p.all().find((n) => n.type === Select)!;
  expect(select().props.options.map((o: { label: string }) => o.label)).toEqual([
    "5 minutes without use",
    "10 minutes without use",
    "30 minutes without use",
    "60 minutes without use",
  ]);
  select().props.onChange({ target: { value: "30" } });
  await tick();
  expect((await api.lspSettingsGet()).idleMinutes).toBe(30);
  p.button("Forget trusted repos").props.onClick();
  await tick();
  expect((await api.lspSettingsGet()).trusted).toEqual([]);
  const status = p.all().find((n) => n.props.role === "status")!;
  expect(text(status.props.children)).toBe("Forgot 2 repos.");
  expect(p.button("Forget trusted repos").props.disabled).toBe(true);
});

it("a search hides the rows it does not hit", async () => {
  const api = createMockApi({});
  const filter = { query: "rust", ids: new Set(["code.lang.rust"]) };
  const draw = () => {
    hooks.cursor = 0;
    hooks.active = true;
    try { return CodeIntelPage({ api, onChanged: vi.fn(), filter }); } finally { hooks.active = false; }
  };
  draw();
  hooks.effects.splice(0).forEach((e) => e());
  await tick();
  const ids = nodes(draw()).map((n) => n.props["data-setting-id"]).filter(Boolean);
  expect(ids).toEqual(["code.lang.rust"]);
});
