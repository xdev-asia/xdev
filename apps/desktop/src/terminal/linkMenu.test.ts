import { describe, expect, it, vi } from "vitest";
import type { ApiError } from "@/api";
import { translate } from "@/i18n";
import { fileLinkMenu, openDefaultLink, openUrlLink, urlLinkMenu, type LinkDeps } from "./linkMenu";

const reject = (code: ApiError["code"]) => Promise.reject({ code });

function deps(more: Partial<LinkDeps> = {}, mac = false) {
  const toasts: string[] = [];
  const calls: string[] = [];
  const d: LinkDeps = {
    api: {
      fileOpenDefault: vi.fn(async () => {}),
      fileReveal: vi.fn(async () => {}),
      openUrl: vi.fn(async () => {}),
    },
    openFile: vi.fn(),
    copyText: vi.fn(async () => true),
    toast: (text) => toasts.push(text),
    t: (key, vars) => translate("en", key, vars),
    mac,
    onSettings: () => calls.push("settings"),
    focusTerminal: () => calls.push("focus"),
    ...more,
  };
  return { d, toasts, calls };
}
const target = { worktree: "/wt", rel: "src/a.ts", line: 12, column: 5 };
const run = async (id: string, items: ReturnType<typeof fileLinkMenu>["items"]) => {
  items.find((i) => i.id === id)!.run!();
  await new Promise((r) => setTimeout(r, 0));
};

describe("fileLinkMenu", () => {
  it("lists the rows in order with the platform's chords and the target as the title", () => {
    const { d } = deps();
    const menu = fileLinkMenu(target, d);
    expect(menu.title).toBe("src/a.ts:12:5");
    expect(menu.items.map((i) => i.id)).toEqual(["open", "openDefault", "reveal", "sep1", "copyPath", "settings"]);
    expect(menu.items.map((i) => i.labelKey)).toEqual(["termLink.open", "termLink.openDefault", "files.menu.reveal", "", "termLink.copyPath", "termLink.settings"]);
    expect(menu.items.map((i) => i.chord)).toEqual(["Ctrl+Click", "Shift+Ctrl+Click", undefined, undefined, undefined, undefined]);
    const mac = fileLinkMenu(target, deps({}, true).d);
    expect(mac.items.slice(0, 2).map((i) => i.chord)).toEqual(["⌘ Click", "⇧⌘ Click"]);
    expect(fileLinkMenu({ worktree: "/wt", rel: "a.ts" }, d).title).toBe("a.ts");
  });

  it("Open file goes through openFile with line and column", async () => {
    const { d, calls } = deps();
    await run("open", fileLinkMenu(target, d).items);
    expect(d.openFile).toHaveBeenCalledWith({ worktree: "/wt", rel: "src/a.ts", line: 12, column: 5 });
    expect(calls).toEqual(["focus"]);
    await run("open", fileLinkMenu({ worktree: "/wt", rel: "a.ts" }, d).items);
    expect(d.openFile).toHaveBeenLastCalledWith({ worktree: "/wt", rel: "a.ts" });
  });

  it("the other rows call the api, the clipboard and the settings", async () => {
    const { d, toasts, calls } = deps();
    const { items } = fileLinkMenu(target, d);
    await run("openDefault", items);
    await run("reveal", items);
    await run("copyPath", items);
    await run("settings", items);
    expect(d.api.fileOpenDefault).toHaveBeenCalledWith("/wt", "src/a.ts");
    expect(d.api.fileReveal).toHaveBeenCalledWith("/wt", "src/a.ts");
    expect(d.copyText).toHaveBeenCalledWith("src/a.ts:12:5");
    expect(toasts).toEqual(["Copied file path"]);
    expect(calls).toEqual(["focus", "focus", "focus", "settings", "focus"]);
  });

  it("shows and copies the raw target when given one", async () => {
    const { d } = deps();
    const menu = fileLinkMenu(target, d, "file:///wt/src/a.ts");
    expect(menu.title).toBe("file:///wt/src/a.ts");
    await run("copyPath", menu.items);
    expect(d.copyText).toHaveBeenCalledWith("file:///wt/src/a.ts");
  });

  it("a failed copy says so", async () => {
    const { d, toasts } = deps({ copyText: async () => false });
    await run("copyPath", fileLinkMenu(target, d).items);
    expect(toasts).toEqual(["Failed to copy file path"]);
  });

  it("a denied default-app open reveals the file and says so, any other failure names the file", async () => {
    const revealed: string[] = [];
    const denied = deps({ api: { fileOpenDefault: () => reject("denied"), fileReveal: async (_w: string, rel: string) => void revealed.push(rel), openUrl: async () => {} } });
    await openDefaultLink(target, denied.d);
    expect(revealed).toEqual(["src/a.ts"]);
    expect(denied.toasts).toEqual(["This type is not opened with the default app. Shown in the file manager instead"]);
    const broken = deps({ api: { fileOpenDefault: () => reject("io"), fileReveal: () => reject("not_found"), openUrl: () => reject("io") } });
    await openDefaultLink(target, broken.d);
    await run("reveal", fileLinkMenu(target, broken.d).items);
    await openUrlLink("https://x.dev", broken.d);
    expect(broken.toasts).toEqual(["Could not open src/a.ts", "Could not open src/a.ts", "Could not open https://x.dev"]);
  });
});

describe("urlLinkMenu", () => {
  it("lists the URL rows and copies the link", async () => {
    const { d, toasts, calls } = deps();
    const menu = urlLinkMenu("https://x.dev/a?b", d);
    expect(menu.title).toBe("https://x.dev/a?b");
    expect(menu.items.map((i) => i.id)).toEqual(["openUrl", "sep1", "copyLink", "settings"]);
    expect(menu.items[0]!.chord).toBe("Ctrl+Click");
    expect(urlLinkMenu("https://x.dev", deps({}, true).d).items[0]!.chord).toBe("⌘ Click");
    await run("openUrl", menu.items);
    await run("copyLink", menu.items);
    await run("settings", menu.items);
    expect(d.api.openUrl).toHaveBeenCalledWith("https://x.dev/a?b");
    expect(d.copyText).toHaveBeenCalledWith("https://x.dev/a?b");
    expect(toasts).toEqual(["Copied link"]);
    expect(calls).toEqual(["focus", "focus", "settings", "focus"]);
  });

  it("a failed copy says so", async () => {
    const { d, toasts } = deps({ copyText: async () => false });
    await run("copyLink", urlLinkMenu("https://x.dev", d).items);
    expect(toasts).toEqual(["Failed to copy link"]);
  });
});
