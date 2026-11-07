import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DocsHost } from "@/docs/DocsHost";
import en from "@/i18n/en.json";
import { translate } from "@/i18n";
import { CrashView, ErrorBoundary } from "./ErrorBoundary";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

describe("ErrorBoundary", () => {
  it("renders its children while nothing has thrown", () => {
    expect(renderToStaticMarkup(<ErrorBoundary><p>ok</p></ErrorBoundary>)).toBe("<p>ok</p>");
  });

  it("keeps the error a view threw, wrapping non-Error values", () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error("boom")).error.message).toBe("boom");
    expect(ErrorBoundary.getDerivedStateFromError("bad").error.message).toBe("bad");
  });

  it("shows the crash view with the message and a reload button instead of a blank window", () => {
    const html = renderToStaticMarkup(<CrashView error={new Error("boom")} />);
    expect(html).toContain('role="alert"');
    expect(html).toContain(en["app.crash.title"]);
    expect(html).toContain("boom");
    expect(html).toContain(en["app.crash.reload"]);
    expect(html).toContain(en["app.crash.body"]);
  });
});

describe("ErrorBoundary report", () => {
  it("records the crash as app.root and tells the person to reload", async () => {
    const { api } = await import("@/api");
    const spy = vi.spyOn(api, "crashRecordRender").mockResolvedValue(null);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const b = new ErrorBoundary({ children: null });
    b.componentDidCatch(new Error("root boom"), { componentStack: " at App" } as never);
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ boundary: "app.root", message: "root boom" }));
    expect(en["app.crash.title"]).toBe("xDev hit a renderer error.");
  });
});

describe("DocsHost boot", () => {
  it("says the folder is opening instead of showing an empty page", () => {
    const html = renderToStaticMarkup(<DocsHost navSlot={null} request={null} onStatus={() => {}} />);
    expect(html).toContain('role="status"');
    expect(html).toContain(en["vault.opening"]);
  });
});
