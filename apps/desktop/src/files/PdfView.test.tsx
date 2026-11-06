import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createMockApi } from "@/api";
import { translate } from "@/i18n";
import type { PdfDoc, PdfEngine } from "./pdfEngine";
import { PdfSession } from "./pdfSession";
import { PdfToolbar, PdfView, isFindKey } from "./PdfView";

vi.mock("@/i18n", async (original) => ({
  ...(await original<typeof import("@/i18n")>()),
  useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }),
}));

const BYTES = new Uint8Array([37, 80, 68, 70]);

function doc(pages: number): PdfDoc {
  return {
    pages,
    size: async () => ({ w: 612, h: 792 }),
    render: vi.fn(() => ({ done: Promise.resolve(), cancel() {} })),
    text: async () => ["x"],
    destroy: vi.fn(),
  };
}

async function ready(pages = 3) {
  const engine: PdfEngine = { open: async () => doc(pages) };
  const session = new PdfSession({ fileBytes: async () => BYTES }, engine, "/wt", "docs/a.pdf");
  await session.load();
  return session;
}

const view = (session: PdfSession) =>
  renderToStaticMarkup(<PdfView api={createMockApi({})} worktree="/wt" rel="docs/a.pdf" session={session} />);

describe("PdfView", () => {
  it("shows a labelled region with a spinner while loading", () => {
    const session = new PdfSession({ fileBytes: () => new Promise(() => {}) }, { open: async () => doc(1) }, "/wt", "a.pdf");
    const html = view(session);
    expect(html).toContain('aria-label="PDF preview"');
    expect(html).toContain("Loading PDF");
  });

  it("renders the toolbar and one box per page when ready", async () => {
    const session = await ready(3);
    const html = view(session);
    expect(html).toContain('aria-label="PDF preview"');
    expect(html).toContain("a.pdf");
    expect(html).toContain("3 pages");
    expect(html.match(/class="pdf-page"/g)).toHaveLength(3);
    expect(html).toContain('data-page="3"');
    expect(html).toContain("--total-scale-factor");
  });

  it.each([
    ["too_large", "50 mb"],
    ["password", "password"],
    ["invalid", "not a valid pdf"],
  ])("explains %s and offers the default app", async (code, word) => {
    const api = { fileBytes: async () => Promise.reject({ code }) };
    const failing = code === "too_large" ? api : { fileBytes: async () => BYTES };
    const engine: PdfEngine = {
      open: async () => {
        throw { name: code === "password" ? "PasswordException" : "InvalidPDFException" };
      },
    };
    const session = new PdfSession(failing, engine, "/wt", "a.pdf");
    await session.load();
    const html = view(session);
    expect(html.toLowerCase()).toContain(word);
    expect(html).toContain("Open in default app");
  });

  it("falls back to the load error with retry for other codes", async () => {
    const session = new PdfSession({ fileBytes: async () => Promise.reject({ code: "not_found" }) }, { open: async () => doc(1) }, "/wt", "a.pdf");
    await session.load();
    expect(view(session)).toContain("Retry");
  });
});

describe("PdfToolbar", () => {
  const html = async (page: number) => {
    const session = await ready(3);
    session.setPage(page);
    return renderToStaticMarkup(<PdfToolbar rel="docs/a.pdf" state={session.get()} session={session} onFind={() => {}} onOpenDefault={() => {}} />);
  };

  it("disables previous on the first page and next on the last", async () => {
    const first = await html(1);
    expect(first).toMatch(/disabled=""[^>]*aria-label="Previous page"|aria-label="Previous page"[^>]*disabled=""/);
    expect(first).not.toMatch(/aria-label="Next page"[^>]*disabled=""|disabled=""[^>]*aria-label="Next page"/);
    const last = await html(3);
    expect(last).toMatch(/aria-label="Next page"[^>]*disabled=""|disabled=""[^>]*aria-label="Next page"/);
  });

  it("shows the current page in the number field and the total", async () => {
    const out = await html(2);
    expect(out).toContain('value="2"');
    expect(out).toContain('max="3"');
    expect(out).toContain("/ 3");
  });

  it("has a find button and one primary-free action row", async () => {
    const out = await html(1);
    expect(out).toContain('aria-label="Find in PDF"');
    expect(out).not.toContain("btn-primary");
  });
});

describe("isFindKey", () => {
  const key = (k: string, mods: Partial<{ ctrlKey: boolean; metaKey: boolean; altKey: boolean }>) => isFindKey({ key: k, ctrlKey: false, metaKey: false, altKey: false, ...mods });
  it("accepts Ctrl+F and Cmd+F in either case", () => {
    expect(key("f", { ctrlKey: true })).toBe(true);
    expect(key("F", { metaKey: true })).toBe(true);
  });
  it("ignores a bare F, Alt combinations and other keys", () => {
    expect(key("f", {})).toBe(false);
    expect(key("f", { ctrlKey: true, altKey: true })).toBe(false);
    expect(key("g", { ctrlKey: true })).toBe(false);
  });
});
