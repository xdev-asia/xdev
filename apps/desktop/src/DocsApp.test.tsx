import { expect, it, vi } from "vitest";
import { translate } from "@/i18n";
import { TasksView } from "./components/TasksView";
import { VaultView, type AppRequest } from "./DocsApp";
import { mount, nodes, tick } from "./kit/testHooks";

vi.mock("react", async (original) => (await import("./kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));
vi.mock("./components/TasksView", () => ({ TasksView: () => null }));

const vault = { path: "/vault", name: "vault", docs: [] } as never;

vi.stubGlobal("window", { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });

async function open(request: AppRequest | null) {
  const m = mount(VaultView, () => ({ vault, appRequest: request, onChangeFolder: async () => {} }));
  await m.settle();
  await tick();
  return m;
}

it("an app request that carries a task shows Tasks focused on it", async () => {
  const m = await open({ app: "tasks", task: "t1", seq: 1 });
  await m.settle();
  const view = nodes(m.draw()).find((n) => n.type === TasksView);
  expect(view?.props.initial).toBe("t1");
});

it("an app request without a task shows Tasks with no focus", async () => {
  const m = await open({ app: "tasks", seq: 1 });
  await m.settle();
  const view = nodes(m.draw()).find((n) => n.type === TasksView);
  expect(view).toBeDefined();
  expect(view?.props.initial).toBeUndefined();
});

it("the same task asked for twice remounts Tasks on it", async () => {
  let request: AppRequest = { app: "tasks", task: "t1", seq: 1 };
  const m = mount(VaultView, () => ({ vault, appRequest: request, onChangeFolder: async () => {} }));
  await m.settle();
  await tick();
  const first = nodes(m.draw()).find((n) => n.type === TasksView);
  request = { app: "tasks", task: "t1", seq: 2 };
  m.draw();
  await m.settle();
  const second = nodes(m.draw()).find((n) => n.type === TasksView);
  expect(second?.props.initial).toBe("t1");
  expect(second?.key).not.toBe(first?.key);
});
