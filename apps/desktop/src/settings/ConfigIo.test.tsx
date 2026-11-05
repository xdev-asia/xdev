import { expect, it, vi } from "vitest";
import { Button } from "@xdev-asia/ui";
import { createMockApi } from "@/api";
import { mount, textOf, tick, type Node } from "@/kit/testHooks";
import { translate } from "@/i18n";
import { ConfigIo } from "./ConfigIo";

vi.mock("react", async (original) => (await import("@/kit/testHooks")).patchReact(await original<typeof import("react")>()));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const act = (all: Node[], name: string) => all.find((n) => n.type === Button && n.props["data-act"] === name)!;
const body = (all: Node[]) =>
  all
    .map((n) => [n.props.children].flat().filter((c) => typeof c === "string").join(""))
    .join("|");

it("exports the ticked sections through the save dialog and says where it went", async () => {
  const api = createMockApi({});
  const out = vi.spyOn(api, "configExport");
  const m = mount(ConfigIo, () => ({ api }));
  m.all()
    .find((n) => n.type === "input" && n.props.value === "git")!
    .props.onChange();
  act(m.all(), "export-settings").props.onClick();
  await tick();
  expect(out).toHaveBeenCalledTimes(1);
  expect(out.mock.calls[0][0]).not.toContain("git");
  expect(out.mock.calls[0][0]).toContain("network");
  expect(body(m.all())).toContain("export-1.json");
});

it("previews an import section by section and applies only the chosen ones", async () => {
  const api = createMockApi({});
  const apply = vi.spyOn(api, "configImportApply");
  const m = mount(ConfigIo, () => ({ api }));
  act(m.all(), "import-settings").props.onClick();
  await tick();
  await tick();
  const all = m.all();
  const text = body(all);
  expect(text).toContain("Import from xdev-settings.json");
  expect(text).toContain("proxyUrl");
  expect(text).toContain("http://127.0.0.1:8080");
  expect(text).toContain("futureField");
  expect(text).toContain("mystery");
  // The secret in the file is counted, never shown.
  expect(text).not.toContain("do-not-import");
  expect(text).toContain("Secrets ignored: 1");
  expect(textOf(act(all, "apply-import"))).toBe("Apply selected");
  act(all, "apply-import").props.onClick();
  await tick();
  expect(apply).toHaveBeenCalledWith("/demo/xdev-settings.json", ["network"]);
  expect(body(m.all())).toContain("Applied 1 sections.");
  expect((await api.networkSettings()).proxyUrl).toBe("http://127.0.0.1:8080");
  expect(await api.networkSettings()).not.toHaveProperty("token");
});

it("shows a refused file as an alert and changes nothing", async () => {
  const api = createMockApi({});
  vi.spyOn(api, "configImportPreview").mockRejectedValue({ code: "config_version", detail: "9" });
  const m = mount(ConfigIo, () => ({ api }));
  act(m.all(), "import-settings").props.onClick();
  await tick();
  await tick();
  const alert = m.all().find((n) => n.props.role === "alert")!;
  expect(textOf(alert)).toBe(translate("en", "error.config_version"));
  expect(m.all().some((n) => n.props["data-act"] === "apply-import")).toBe(false);
});
