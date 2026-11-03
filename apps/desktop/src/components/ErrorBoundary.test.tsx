import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { DocsApp } from "@/DocsApp";
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
  });
});

describe("DocsApp boot", () => {
  it("says the folder is opening instead of showing an empty page", () => {
    const html = renderToStaticMarkup(<DocsApp />);
    expect(html).toContain('role="status"');
    expect(html).toContain(en["vault.opening"]);
  });
});
