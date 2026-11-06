import { describe, expect, it } from "vitest";
import type { ApiError } from "@/api";
import { createMockBrowser } from "@/mockBrowser";
import { zoomScale } from "./BrowserTab";

// The backend's `normalize_address` is the rule and has its own tests; this checks that the stand-in
// the mock app uses agrees with it on the cases the brief names.
const code = (p: Promise<unknown>) => p.then(() => "ok", (e: ApiError) => e.code);

describe("the address field", () => {
  it.each([
    ["example.com", "https://example.com"],
    ["  example.com/docs?q=1  ", "https://example.com/docs?q=1"],
    ["https://example.com/", "https://example.com/"],
    ["localhost:3000", "http://localhost:3000"],
    ["localhost", "http://localhost"],
    ["127.0.0.1:8080/api", "http://127.0.0.1:8080/api"],
    ["app.localhost:5173", "http://app.localhost:5173"],
    ["about:blank", "about:blank"],
  ])("%s loads %s without a template", async (input, want) => {
    expect(await createMockBrowser().browserNavigate("browser:1", input)).toBe(want);
  });

  it("text with no scheme and no dot searches with the template", async () => {
    const b = createMockBrowser();
    await b.browserSettingsPut({ openLinksIn: "system", searchTemplate: "https://search.example/?q=%s" });
    expect(await b.browserNavigate("browser:1", "rust lifetimes")).toBe("https://search.example/?q=rust%20lifetimes");
    expect(await b.browserNavigate("browser:1", "xdev")).toBe("https://search.example/?q=xdev");
    expect(await b.browserNavigate("browser:1", "example.com")).toBe("https://example.com");
    expect(await b.browserNavigate("browser:1", "localhost:3000")).toBe("http://localhost:3000");
  });

  it("without a template the same text goes to https://", async () => {
    expect(await createMockBrowser().browserNavigate("browser:1", "xdev")).toBe("https://xdev");
  });

  it("an empty field or a scheme a tab does not load is refused", async () => {
    const b = createMockBrowser();
    expect(await code(b.browserNavigate("browser:1", "   "))).toBe("browser_empty");
    expect(await code(b.browserNavigate("browser:1", "file:///etc/hosts"))).toBe("browser_scheme");
    expect(await code(b.browserNavigate("browser:1", "javascript:void(0)"))).toBe("browser_scheme");
  });

  it("a template needs %s and an http(s) address", async () => {
    const b = createMockBrowser();
    expect(await code(b.browserSettingsPut({ openLinksIn: "pane", searchTemplate: "https://search.example/" }))).toBe("browser_template");
    expect(await code(b.browserSettingsPut({ openLinksIn: "pane", searchTemplate: "ftp://x/?q=%s" }))).toBe("browser_template");
    expect(await b.browserSettingsPut({ openLinksIn: "pane", searchTemplate: "  " })).toEqual({ openLinksIn: "pane", searchTemplate: "" });
  });
});

describe("the live webviews of the mock", () => {
  const at = { x: 0, y: 40, width: 640, height: 400 };

  it("keeps three; the oldest is evicted with its URL", async () => {
    const b = createMockBrowser();
    const gone: { tab: string; url: string }[] = [];
    await b.onBrowserEvicted((e) => void gone.push(e));
    for (const n of [1, 2, 3, 4]) await b.browserShow(`browser:${n}`, `https://x.dev/${n}`, at);
    expect(b.__browserLive()).toEqual(["browser:2", "browser:3", "browser:4"]);
    expect(gone).toEqual([{ tab: "browser:1", url: "https://x.dev/1" }]);
    await b.browserHide("browser:3");
    expect(b.__browserBounds("browser:3")).toBeNull();
    await b.browserClose("browser:9");
    expect(b.__browserLive()).toHaveLength(3);
  });

  it("refuses to show where the platform has no webview", async () => {
    expect(await code(createMockBrowser({ unavailable: true }).browserShow("browser:1", "https://x.dev/", at))).toBe("browser_unavailable");
  });
});

describe("zoomScale", () => {
  it.each([
    [1280, 1280, 1],
    [1280, 1024, 1.25],
    [1280, 1275, 1],
    [0, 1280, 1],
    [1280, 0, 1],
    [1280, 100, 1],
  ])("viewport %d over root %d scales by %d", (viewport, root, want) => {
    expect(zoomScale(viewport, root)).toBeCloseTo(want);
  });
});
