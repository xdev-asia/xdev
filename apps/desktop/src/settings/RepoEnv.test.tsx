import { expect, it, vi } from "vitest";
import { createMockApi, type RepoView } from "@/api";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { DEMO_WORKSPACE } from "@/mockWorkspace";
import { RepoEnv } from "./RepoEnv";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string) => translate("en", key);

async function open(env?: RepoView["env"], before?: (api: ReturnType<typeof createMockApi>) => Promise<void>) {
  const seed = structuredClone(DEMO_WORKSPACE);
  if (env) seed.repos[0].env = env;
  const api = createMockApi({}, { workspace: seed });
  await before?.(api);
  let repo = (await api.workspaceList())[0];
  const onSaved = vi.fn((next: RepoView) => void (repo = next));
  const m = mount(RepoEnv, () => ({ api, repo, onSaved }));
  await m.settle();
  await m.settle();
  return { api, m, onSaved };
}
const named = (all: Node[], name: string) => all.filter((n) => n.type === "input" && n.props.name === name);
const button = (all: Node[], attr: string) => all.find((n) => n.type === "button" && attr in n.props)!;
const previewText = (all: Node[]) => textOf(all.find((n) => n.props["data-env-preview"] !== undefined) ?? ({ props: {} } as Node));

it("starts empty with Save disabled", async () => {
  const { m } = await open();
  const all = m.all();
  expect(named(all, "envKey")).toHaveLength(0);
  expect(button(all, "data-env-save").props.disabled).toBe(true);
});

it("lists saved rows and previews them with the secret masked", async () => {
  const { m } = await open(
    [
      { key: "PLAIN", value: "v", secret: false },
      { key: "TOKEN", value: "", secret: true },
    ],
    (api) => api.repoEnvSecretSet("demo-xdev", "TOKEN", "hunter2"),
  );
  const all = m.all();
  expect(named(all, "envKey").map((n) => n.props.value)).toEqual(["PLAIN", "TOKEN"]);
  expect(named(all, "envValue")[1].props.type).toBe("password");
  const text = JSON.stringify(all.map((n) => n.props.children ?? null));
  expect(text).toContain("••••••••");
  expect(text).not.toContain("hunter2");
});

it("refuses a bad key, then saves the row and keeps a secret value out of the patch", async () => {
  const { m, api, onSaved } = await open();
  const update = vi.spyOn(api, "repoUpdate");
  const setSecret = vi.spyOn(api, "repoEnvSecretSet");
  button(m.all(), "data-env-add").props.onClick();
  let all = m.all();
  named(all, "envKey")[0].props.onChange({ target: { value: "1bad" } });
  all = m.all();
  expect(button(all, "data-env-save").props.disabled).toBe(true);
  expect(JSON.stringify(all.map((n) => n.props.children ?? null))).toContain(en("settings.repos.env.key.invalid"));

  named(all, "envKey")[0].props.onChange({ target: { value: "API_TOKEN" } });
  named(m.all(), "envValue")[0].props.onChange({ target: { value: "hunter2" } });
  named(m.all(), "envSecret")[0].props.onChange({ target: { checked: true } });
  named(m.all(), "envValue")[0].props.onChange({ target: { value: "hunter2" } });
  expect(button(m.all(), "data-env-save").props.disabled).toBe(false);
  button(m.all(), "data-env-save").props.onClick();
  await tick();
  await m.settle();
  expect(update).toHaveBeenCalledWith("demo-xdev", { env: [{ key: "API_TOKEN", value: "", secret: true }] });
  expect(setSecret).toHaveBeenCalledWith("demo-xdev", "API_TOKEN", "hunter2");
  expect(onSaved).toHaveBeenCalledTimes(1);
  const after = m.all();
  expect(previewText(after)).toContain("API_TOKEN");
  expect(JSON.stringify(after.map((n) => n.props.value ?? null))).not.toContain("hunter2");
});

it("refuses a reserved name", async () => {
  const { m } = await open();
  button(m.all(), "data-env-add").props.onClick();
  named(m.all(), "envKey")[0].props.onChange({ target: { value: "XDEV_ROOT_PATH" } });
  const all = m.all();
  expect(JSON.stringify(all.map((n) => n.props.children ?? null))).toContain(en("settings.repos.env.key.reserved"));
  expect(button(all, "data-env-save").props.disabled).toBe(true);
});
