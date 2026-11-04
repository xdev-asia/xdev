import type { ErrorInfo } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import en from "@/i18n/en.json";
import { translate } from "@/i18n";
import { resetSurfaceReports } from "@/crash/surfaceReport";
import { SurfaceBoundary } from "./SurfaceBoundary";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const info = { componentStack: "\n at X" } as ErrorInfo;

function instance(props: Partial<ConstructorParameters<typeof SurfaceBoundary>[0]> & { api?: never } = {}, api = { crashRecordRender: vi.fn(async () => null) }) {
  const b = new SurfaceBoundary({ id: "x.y", surface: "Surface", api, children: null, ...props });
  return { b, api };
}

describe("SurfaceBoundary", () => {
  beforeEach(() => {
    resetSurfaceReports();
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders its children while nothing has thrown", () => {
    expect(renderToStaticMarkup(<SurfaceBoundary id="a" surface="A"><p>ok</p></SurfaceBoundary>)).toBe("<p>ok</p>");
  });

  it("wraps values that are not errors", () => {
    expect(SurfaceBoundary.getDerivedStateFromError("bad").error.message).toBe("bad");
  });

  it("shows a banner with one secondary retry button and an overridable title", () => {
    const { b } = instance({ titleKey: "boundary.retry" });
    b.state = { error: new Error("boom"), resetKey: undefined };
    const html = renderToStaticMarkup(b.render() as never);
    expect(html).toContain("banner banner-warn");
    expect(html).toContain(en["boundary.body"]);
    expect(html.match(/btn-secondary/g)).toHaveLength(1);
    expect(html).not.toContain(en["boundary.title"]);
  });

  it("clears the error on a new reset key and keeps it on the same one", () => {
    const state = { error: new Error("x"), resetKey: "a" };
    const same = SurfaceBoundary.getDerivedStateFromProps({ id: "i", surface: "s", resetKey: "a", children: null }, state);
    const next = SurfaceBoundary.getDerivedStateFromProps({ id: "i", surface: "s", resetKey: "b", children: null }, state);
    expect(same).toBeNull();
    expect(next).toEqual({ error: null, resetKey: "b" });
  });

  it("reports a catch once and skips the report when asked", () => {
    const a = instance();
    a.b.componentDidCatch(new Error("boom"), info);
    a.b.componentDidCatch(new Error("boom"), info);
    expect(a.api.crashRecordRender).toHaveBeenCalledTimes(1);
    expect(a.api.crashRecordRender).toHaveBeenCalledWith(expect.objectContaining({ boundary: "x.y", surface: "Surface", message: "boom" }));
    const quiet = instance({ report: false, id: "q" });
    quiet.b.componentDidCatch(new Error("other"), info);
    expect(quiet.api.crashRecordRender).not.toHaveBeenCalled();
  });
});
