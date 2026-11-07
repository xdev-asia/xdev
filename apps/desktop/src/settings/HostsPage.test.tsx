import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createMockApi, type HostScopeEntry, type HostSettingsView, type SshHost } from "@/api";
import { DEMO_SEED } from "@/mockApi";
import { translate } from "@/i18n";
import { errorField, HostsPanel, saveHost, type HostsPanelProps } from "./HostsPage";
import { toForm } from "./hosts/hostModel";
import { SECTIONS } from "./sections";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const local: HostScopeEntry = { id: "local", alias: "local", label: "Local", overrides: 0 };
const box: HostScopeEntry = { id: "h1", alias: "box", label: "box", overrides: 0 };
const view: HostSettingsView = {
  hostId: "h1",
  stored: { label: null, shell: null, env: [], history: { enabled: null, claudeHome: null, codexHome: null, days: null } },
  effective: { label: "box", shell: null, env: [], history: { enabled: true, claudeHome: "~/.claude", codexHome: "~/.codex", days: 90 } },
  history: { files: 0, bytes: 0, capped: false },
};

function panel(over: Partial<HostsPanelProps>): string {
  const props: HostsPanelProps = {
    entries: [local, box],
    hostId: "h1",
    view,
    form: toForm(view.stored),
    busy: false,
    onPick() {},
    onForm() {},
    onSave() {},
    onOpenSsh() {},
    onOpenSection() {},
    ...over,
  };
  return renderToStaticMarkup(<HostsPanel {...props} /> as ReactElement);
}
const primaries = (html: string) => (html.match(/class="btn[^"]*"/g) ?? []).filter((c) => !/secondary|ghost|link|danger/.test(c)).length;

describe("Settings → Hosts", () => {
  it("is a section after SSH", () => {
    const ids = SECTIONS.map((s) => s.id);
    expect(ids.indexOf("hosts")).toBe(ids.indexOf("ssh") + 1);
  });

  it("with no SSH host shows an empty state with one primary button", () => {
    const html = panel({ entries: [local], hostId: "local", view: null, form: null });
    expect(html).toContain(en("settings.hosts.empty"));
    expect(html).toContain(en("settings.hosts.addHost"));
    expect(primaries(html)).toBe(1);
  });

  it("Local shows links only: no form and no primary button", () => {
    const html = panel({ hostId: "local", view: null, form: null });
    expect(html).toContain(en("settings.hosts.openTerminal"));
    expect(html).not.toContain("<form");
    expect(primaries(html)).toBe(0);
  });

  it("a host shows its form with one primary button, disabled until something changes", () => {
    const html = panel({});
    expect(html).toContain(en("settings.hosts.label"));
    expect(html).toContain(en("settings.hosts.shell"));
    expect(primaries(html)).toBe(1);
    expect(html).toMatch(/type="submit"[^>]*disabled|disabled[^>]*type="submit"/);
  });

  it("a bad path is explained under the field", () => {
    const form = { ...toForm(view.stored), shell: "bash" };
    const html = panel({ form, error: { code: "bad_path", field: errorField("bad_path", form, view) } });
    expect(html).toContain(en("settings.hosts.error.bad_path"));
  });

  it("the picker lists Local first and marks hosts that override values", () => {
    const html = panel({ entries: [local, { ...box, overrides: 2 }] });
    expect(html.indexOf(en("settings.hosts.local"))).toBeLessThan(html.indexOf("box (2 set)"));
  });
});

describe("saving a host", () => {
  const host: SshHost = { id: "h1", alias: "box", hostName: "box.example.com", source: "manual", forwardAgent: false, localForwards: [], extraOptions: [] };

  it("puts only the changed key and returns the stored view", async () => {
    const api = createMockApi(DEMO_SEED);
    api.sshHostsList = async () => [host];
    const put = vi.spyOn(api, "hostSettingsPut");
    const got = await api.hostSettingsGet("h1");
    const form = { ...toForm(got.stored), label: "Build box" };
    const saved = await saveHost(api, got, form);
    expect(put).toHaveBeenCalledTimes(1);
    expect(saved.stored.label).toBe("Build box");
    expect(saved.stored.shell).toBeNull();
  });

  it("does not call the store when nothing changed", async () => {
    const api = createMockApi(DEMO_SEED);
    api.sshHostsList = async () => [host];
    const put = vi.spyOn(api, "hostSettingsPut");
    const got = await api.hostSettingsGet("h1");
    await saveHost(api, got, toForm(got.stored));
    expect(put).not.toHaveBeenCalled();
  });
});
