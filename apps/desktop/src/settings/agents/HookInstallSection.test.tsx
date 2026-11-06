import { beforeEach, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Button, Disclosure, StatusDot } from "@xdev-asia/ui";
import { createMockApi, type Cli } from "@/api";
import { translate } from "@/i18n";
import { HookInstallSection } from "./HookInstallSection";

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, effects: [] as (() => void)[] }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = hooks.cursor++;
      if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? initial() : initial;
      return [hooks.values[index], (value: unknown) => { hooks.values[index] = typeof value === "function" ? value(hooks.values[index]) : value; }];
    },
    useEffect: (effect: () => void) => void hooks.effects.push(effect),
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
const nameOf = (cli: Cli) => `name-${cli}`;

beforeEach(() => {
  hooks.values = [];
  hooks.effects = [];
});

async function section(api = createMockApi({})) {
  const draw = () => {
    hooks.cursor = 0;
    return nodes(HookInstallSection({ api, nameOf }));
  };
  draw();
  for (const effect of hooks.effects.splice(0)) effect();
  await tick();
  return { api, all: draw };
}

const row = (all: Node[], cli: Cli) => all.find((n) => n.type === "li" && n.props["data-cli"] === cli)!;

it("lists_launch_and_managed_clis_and_puts_the_rest_under_not_supported", async () => {
  const { all } = await section();
  const shown = all().filter((n) => n.type === "li" && n.props["data-state"]).map((n) => n.props["data-cli"]);
  expect(shown).toEqual(["claude", "codex", "gemini", "copilot", "opencode", "kilo", "antigravity"]);
  expect(nodes(row(all(), "claude")).some((n) => n.props.children === en("settings.agents.hookInstall.launch"))).toBe(true);
  expect(nodes(row(all(), "claude")).some((n) => n.type === Button)).toBe(false);
  const more = all().find((n) => n.type === Disclosure)!;
  expect(more.props.title).toBe(en("settings.agents.hookInstall.unsupported"));
  expect(more.props.count).toBe(13);
  expect(nodes(row(all(), "aider")).some((n) => n.props.children === en("settings.agents.hookInstall.reason.not-checked"))).toBe(true);
});

it("install_then_remove_follows_the_row_with_one_secondary_button_each", async () => {
  const { api, all } = await section();
  const install = vi.spyOn(api, "hookInstall");
  const button = () => nodes(row(all(), "gemini")).find((n) => n.type === Button)!;
  expect(all().filter((n) => n.type === Button).every((b) => b.props.variant === "secondary")).toBe(true);
  expect(button().props.children).toBe(en("settings.agents.hookInstall.install"));
  expect(button().props["aria-label"]).toBe(en("settings.agents.hookInstall.install.for", { name: "name-gemini" }));
  button().props.onClick();
  await tick();
  expect(install).toHaveBeenCalledWith("gemini");
  expect(row(all(), "gemini").props["data-state"]).toBe("installed");
  expect(nodes(row(all(), "gemini")).find((n) => n.type === StatusDot)!.props.tone).toBe("ok");
  expect(button().props.children).toBe(en("settings.agents.hookInstall.remove"));
  button().props.onClick();
  await tick();
  expect(row(all(), "gemini").props["data-state"]).toBe("missing");
});

it("a_failed_install_shows_its_reason_on_the_row", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "hookInstall").mockRejectedValue({ code: "hooks-conflict" });
  const { all } = await section(api);
  nodes(row(all(), "copilot")).find((n) => n.type === Button)!.props.onClick();
  await tick();
  expect(nodes(row(all(), "copilot")).some((n) => n.props.children === en("settings.agents.hookInstall.error.hooks-conflict"))).toBe(true);
});

it("an_outdated_or_unreadable_row_says_so", async () => {
  const api = createMockApi({});
  const rows = await api.hookInstalls();
  vi.spyOn(api, "hookInstalls").mockResolvedValue(
    rows.map((r) => (r.cli === "gemini" ? { ...r, state: null, error: "hooks-unreadable" } : r.cli === "kilo" ? { ...r, state: "outdated" } : r)),
  );
  const { all } = await section(api);
  expect(nodes(row(all(), "gemini")).find((n) => n.type === StatusDot)!.props.tone).toBe("danger");
  expect(nodes(row(all(), "gemini")).some((n) => n.props.children === en("settings.agents.hookInstall.error.hooks-unreadable"))).toBe(true);
  expect(nodes(row(all(), "kilo")).find((n) => n.type === Button)!.props.children).toBe(en("settings.agents.hookInstall.update"));
  expect(nodes(row(all(), "kilo")).find((n) => n.type === StatusDot)!.props.tone).toBe("warn");
});
