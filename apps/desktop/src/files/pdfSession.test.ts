import { describe, expect, it, vi } from "vitest";
import type { PdfDoc, PdfEngine } from "./pdfEngine";
import { PdfSession } from "./pdfSession";

const BYTES = new Uint8Array([37, 80, 68, 70]);

function fakeDoc(pages: string[][], size = { w: 612, h: 792 }) {
  const doc = {
    pages: pages.length,
    size: vi.fn(async () => size),
    render: vi.fn(),
    text: vi.fn(async (p: number) => pages[p - 1]),
    destroy: vi.fn(),
  };
  return doc satisfies PdfDoc;
}

function setup(pages: string[][] = [["Hello world"], ["say hello", "HELLO"], ["none"]]) {
  const doc = fakeDoc(pages);
  const engine: PdfEngine = { open: vi.fn(async () => doc) };
  const api = { fileBytes: vi.fn(async () => BYTES) };
  const session = new PdfSession(api, engine, "/wt", "a.pdf");
  return { doc, engine, api, session };
}

describe("load", () => {
  it("goes from loading to ready with the page sizes", async () => {
    const { session, api } = setup();
    expect(session.get().status).toBe("loading");
    await session.load();
    expect(api.fileBytes).toHaveBeenCalledWith("/wt", "a.pdf");
    expect(session.get()).toMatchObject({ status: "ready", pages: 3, page: 1, bytes: 4, mode: "fit" });
    expect(session.get().sizes).toHaveLength(3);
  });

  it.each(["too_large", "io", "not_found"] as const)("keeps the code %s of a failed read", async (code) => {
    const { session, api } = setup();
    api.fileBytes.mockRejectedValueOnce({ code });
    await session.load();
    expect(session.get()).toMatchObject({ status: "error", error: code });
  });

  it.each([
    [{ name: "PasswordException" }, "password"],
    [{ name: "InvalidPDFException" }, "invalid"],
    [new Error("x"), "engine"],
  ])("maps an engine failure %j to %s", async (err, code) => {
    const { session, engine } = setup();
    vi.mocked(engine.open).mockRejectedValueOnce(err);
    await session.load();
    expect(session.get()).toMatchObject({ status: "error", error: code });
  });

  it("drops the result of a load a newer one replaced", async () => {
    const first = fakeDoc([["a"]]);
    const second = fakeDoc([["a"], ["b"]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const open = vi.fn().mockImplementationOnce(async () => (await gate, first)).mockImplementationOnce(async () => second);
    const session = new PdfSession({ fileBytes: async () => BYTES }, { open }, "/wt", "a.pdf");
    const a = session.load();
    await vi.waitFor(() => expect(open).toHaveBeenCalledTimes(1), { timeout: 2000 });
    const b = session.load();
    await b;
    release();
    await a;
    expect(session.get().pages).toBe(2);
    expect(first.destroy).toHaveBeenCalledTimes(1);
    expect(second.destroy).not.toHaveBeenCalled();
  });

  it("destroys the document once on dispose, and one that opens after it", async () => {
    const { session, doc } = setup();
    await session.load();
    session.dispose();
    session.dispose();
    expect(doc.destroy).toHaveBeenCalledTimes(1);

    const late = fakeDoc([["a"]]);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const opened = vi.fn(async () => (await gate, late));
    const s2 = new PdfSession({ fileBytes: async () => BYTES }, { open: opened }, "/wt", "a.pdf");
    const p = s2.load();
    await vi.waitFor(() => expect(opened).toHaveBeenCalledTimes(1), { timeout: 2000 });
    s2.dispose();
    release();
    await p;
    expect(late.destroy).toHaveBeenCalledTimes(1);
  });
});

describe("pages and zoom", () => {
  it("clamps the page and asks the view to jump", async () => {
    const { session } = setup();
    await session.load();
    const before = session.get().jump;
    session.setPage(9);
    expect(session.get().page).toBe(3);
    expect(session.get().jump).toBe(before + 1);
  });

  it("follows the scroll without a jump", async () => {
    const { session } = setup();
    await session.load();
    const before = session.get().jump;
    session.scrolled(2);
    expect(session.get()).toMatchObject({ page: 2, jump: before });
  });

  it("switches between fit and free", async () => {
    const { session } = setup();
    await session.load();
    session.setBox(360);
    const fit = session.get().scale;
    expect(fit).toBeCloseTo((360 - 16) / (612 * (96 / 72)), 6);
    session.zoomIn();
    expect(session.get()).toMatchObject({ mode: "free" });
    expect(session.get().scale).toBeCloseTo(fit * 1.25, 6);
    session.actual();
    expect(session.get()).toMatchObject({ mode: "free", scale: 1 });
    session.fit();
    expect(session.get()).toMatchObject({ mode: "fit", scale: fit });
    session.zoomOut();
    expect(session.get().mode).toBe("free");
  });

  it("recomputes the fit scale on a resize, and keeps a free one", async () => {
    const { session } = setup();
    await session.load();
    session.setBox(360);
    session.setBox(720);
    expect(session.get().scale).toBeCloseTo((720 - 16) / (612 * (96 / 72)), 6);
    session.actual();
    session.setBox(400);
    expect(session.get().scale).toBe(1);
  });
});

describe("search", () => {
  it("reads every page once, counts across them and caches the text", async () => {
    const { session, doc } = setup();
    await session.load();
    await session.search("hello");
    expect(doc.text).toHaveBeenCalledTimes(3);
    expect(session.get().find).toMatchObject({ total: 3, searching: false, scanned: 3, current: 0 });
    await session.search("world");
    expect(doc.text).toHaveBeenCalledTimes(3);
    expect(session.get().find.total).toBe(1);
  });

  it("grows the total as pages finish", async () => {
    const { session } = setup();
    await session.load();
    const totals: number[] = [];
    session.subscribe(() => totals.push(session.get().find.total));
    await session.search("hello");
    expect(totals[0]).toBeLessThan(3);
    expect(totals.at(-1)).toBe(3);
    expect(totals).toEqual([...totals].sort((a, b) => a - b));
  });

  it("clears on an empty query", async () => {
    const { session } = setup();
    await session.load();
    await session.search("hello");
    await session.search("");
    expect(session.get().find).toMatchObject({ query: "", total: 0, current: -1, searching: false });
  });

  it("never lands the results of an older query", async () => {
    const { session } = setup();
    await session.load();
    const old = session.search("hello");
    const next = session.search("none");
    await Promise.all([old, next]);
    expect(session.get().find).toMatchObject({ query: "none", total: 1, searching: false });
  });

  it("steps with wrap and moves to the page of the match", async () => {
    const { session } = setup();
    await session.load();
    await session.search("hello");
    expect(session.get()).toMatchObject({ page: 1 });
    session.step(1);
    expect(session.get()).toMatchObject({ page: 2 });
    expect(session.get().find.current).toBe(1);
    session.step(1);
    session.step(1);
    expect(session.get().find.current).toBe(0);
    expect(session.get().page).toBe(1);
    session.step(-1);
    expect(session.get().find.current).toBe(2);
  });
});
