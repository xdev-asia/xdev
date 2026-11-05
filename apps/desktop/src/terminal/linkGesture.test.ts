import { describe, expect, it } from "vitest";
import type { TerminalLinkClick } from "@/api";
import { translate } from "@/i18n";
import { linkAction, linkHint, type LinkAction, type LinkGesture } from "./linkGesture";

const click = (more: Partial<LinkGesture> = {}): LinkGesture => ({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...more });
const modes: TerminalLinkClick[] = ["actions", "open", "none"];
const act = (kind: "file" | "url", e: LinkGesture, linkClick: TerminalLinkClick, urlMiddleClick: TerminalLinkClick, mac = false): LinkAction =>
  linkAction(kind, e, { linkClick, urlMiddleClick }, mac);

describe("linkAction", () => {
  it("plain left click follows linkClick", () => {
    for (const kind of ["file", "url"] as const) {
      expect(act(kind, click(), "actions", "open")).toBe("menu");
      expect(act(kind, click(), "open", "open")).toBe("open");
      expect(act(kind, click(), "none", "open")).toBe("none");
    }
  });

  it("Mod+click opens whatever the setting says; Shift+Mod+click opens a file with the default app", () => {
    for (const mode of modes) {
      expect(act("file", click({ ctrlKey: true }), mode, mode)).toBe("open");
      expect(act("url", click({ ctrlKey: true }), mode, mode)).toBe("open");
      expect(act("file", click({ ctrlKey: true, shiftKey: true }), mode, mode)).toBe("openDefault");
      expect(act("url", click({ ctrlKey: true, shiftKey: true }), mode, mode)).toBe("open");
    }
  });

  it("uses ⌘ and not Ctrl on macOS", () => {
    expect(act("file", click({ metaKey: true }), "actions", "open", true)).toBe("open");
    expect(act("file", click({ metaKey: true, shiftKey: true }), "actions", "open", true)).toBe("openDefault");
    expect(act("file", click({ ctrlKey: true }), "open", "open", true)).toBe("none");
    expect(act("file", click({ ctrlKey: true, metaKey: true }), "open", "open", true)).toBe("none");
    // The Windows key is not Mod elsewhere.
    expect(act("file", click({ metaKey: true }), "actions", "open", false)).toBe("menu");
  });

  it("Alt is never a link gesture", () => {
    for (const mode of modes) {
      for (const mac of [false, true]) {
        expect(act("file", click({ altKey: true, ctrlKey: !mac, metaKey: mac }), mode, mode, mac)).toBe("none");
        expect(act("url", click({ altKey: true, button: 1 }), mode, mode, mac)).toBe("none");
      }
    }
  });

  it("Shift alone is left to the terminal", () => {
    expect(act("file", click({ shiftKey: true }), "open", "open")).toBe("none");
    expect(act("url", click({ shiftKey: true }), "actions", "open")).toBe("none");
  });

  it("middle click acts on a URL only, as urlMiddleClick says", () => {
    expect(act("url", click({ button: 1 }), "none", "open")).toBe("open");
    expect(act("url", click({ button: 1 }), "open", "actions")).toBe("menu");
    expect(act("url", click({ button: 1 }), "open", "none")).toBe("none");
    expect(act("file", click({ button: 1 }), "open", "open")).toBe("none");
  });

  it("right click and other buttons do nothing", () => {
    for (const button of [2, 3, 4]) expect(act("url", click({ button, ctrlKey: true }), "open", "open")).toBe("none");
  });
});

describe("linkHint", () => {
  const t = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);

  it("names the click for the platform and the setting", () => {
    expect(linkHint("file", "src/a.ts", "actions", false, t)).toBe("src/a.ts (Click for actions, Ctrl+click to open, or Shift+Ctrl+click for default app)");
    expect(linkHint("file", "src/a.ts", "open", false, t)).toBe("src/a.ts (Ctrl+click to open, or Shift+Ctrl+click for default app)");
    expect(linkHint("file", "src/a.ts", "none", true, t)).toBe("src/a.ts (⌘+click to open, or ⇧⌘+click for default app)");
    expect(linkHint("file", "src/a.ts", "actions", true, t)).toBe("src/a.ts (Click for actions, ⌘+click to open, or ⇧⌘+click for default app)");
  });

  it("has a URL form", () => {
    expect(linkHint("url", "https://x.dev", "actions", false, t)).toBe("https://x.dev (Click for actions, Ctrl+click to open)");
    expect(linkHint("url", "https://x.dev", "open", true, t)).toBe("https://x.dev (⌘+click to open)");
  });

  it("reads in Vietnamese too", () => {
    const vi = (key: string, vars?: Record<string, string | number>) => translate("vi", key, vars);
    expect(linkHint("url", "https://x.dev", "actions", false, vi)).toBe("https://x.dev (Nhấp để xem thao tác, Ctrl+nhấp để mở)");
  });
});
