import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import en from "@/i18n/en.json";
import viDict from "@/i18n/vi.json";
import { translate } from "@/i18n";
import { CreateVaultDialog } from "./CreateVaultDialog";
import { VaultEmpty } from "./NoVaultView";

// Called as plain functions, so the hooks are stubbed out.
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useRef: () => ({ current: null }), useEffect: () => {} }));
vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale: () => {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

type Node = ReactElement<Record<string, any>>;
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}

function dialog(over: Partial<Parameters<typeof CreateVaultDialog>[0]> = {}) {
  const props = {
    open: true,
    path: "C:\\Users\\a\\Documents\\xDev",
    busy: false,
    onPath: vi.fn(),
    onPick: vi.fn(),
    onCreate: vi.fn(),
    onCancel: vi.fn(),
    ...over,
  };
  return { props, html: renderToStaticMarkup(CreateVaultDialog(props)) };
}

describe("CreateVaultDialog", () => {
  it("shows the suggested path in an editable field", () => {
    const { html } = dialog();
    expect(html).toContain('value="C:\\Users\\a\\Documents\\xDev"');
    expect(html).toContain("Choose another place");
    expect(html).toContain("Not now");
  });

  it("offers the language switch, since the top bar is behind the modal", () => {
    expect(dialog().html).toContain(`aria-label="${en["language.label"]}"`);
  });

  it("creates on submit, but not with an empty path or while busy", () => {
    for (const [over, calls] of [[{}, 1], [{ path: "  " }, 0], [{ busy: true }, 0]] as const) {
      const props = { open: true, path: "/x", busy: false, onPath: vi.fn(), onPick: vi.fn(), onCreate: vi.fn(), onCancel: vi.fn(), ...over };
      const form = nodes(CreateVaultDialog(props)).find((n) => n.type === "form")!;
      form.props.onSubmit({ preventDefault() {} });
      expect(props.onCreate).toHaveBeenCalledTimes(calls);
    }
  });

  it("disables Create for an empty path and shows errors", () => {
    expect(dialog({ path: "" }).html).toMatch(/<button type="submit"[^>]*disabled/);
    expect(dialog({ error: "io" }).html).toContain(en["error.io"]);
  });
});

describe("VaultEmpty", () => {
  const render = (failure?: { path: string; code: "not_found" }) =>
    renderToStaticMarkup(<VaultEmpty failure={failure} busy={false} onCreate={() => {}} onOpen={() => {}} />);

  it("offers to create or open a folder", () => {
    const html = render();
    expect(html).toContain(en["vault.create"]);
    expect(html).toContain(en["vault.open"]);
    expect(html).toContain(en["vault.empty.hint"]);
  });

  it("names the folder that could not be opened and why", () => {
    const html = render({ path: "D:\\gone\\docs", code: "not_found" });
    expect(html).toContain("Could not open D:\\gone\\docs.");
    expect(html).toContain(en["error.not_found"]);
    expect(html).not.toContain(en["vault.empty.hint"]);
  });

  it("has every vault key in vi, and a starter name that is a Markdown file", () => {
    const keys = Object.keys(en).filter((key) => key.startsWith("vault."));
    for (const key of keys) expect(viDict).toHaveProperty([key]);
    for (const dict of [en, viDict]) expect(dict["vault.starter.file"]).toMatch(/^[^/\\]+\.md$/);
  });
});
