import { describe, expect, it, vi } from "vitest";
import { ImageSession, type UrlApi } from "./imageSession";

const urls = () => {
  const made: string[] = [];
  const revoked: string[] = [];
  const api: UrlApi = { create: () => (made.push(`blob:${made.length}`), `blob:${made.length - 1}`), revoke: (u) => void revoked.push(u) };
  return { api, made, revoked };
};
const bytes = (n = 4) => ({ fileBytes: vi.fn(async () => new Uint8Array(n)) });

async function ready(rel = "a.png", nat = { w: 800, h: 400 }, box = { w: 432, h: 232 }) {
  const u = urls();
  const s = new ImageSession(bytes(2048), "W", rel, u.api);
  await s.load();
  s.setNatural(nat.w, nat.h);
  s.setBox(box.w, box.h);
  return { s, u };
}

describe("ImageSession", () => {
  it("starts loading, then holds the object URL and byte size", async () => {
    const u = urls();
    const s = new ImageSession(bytes(2048), "W", "a.png", u.api);
    expect(s.get().status).toBe("loading");
    expect(s.percent()).toBeNull();
    await s.load();
    expect(s.get()).toMatchObject({ status: "ready", url: "blob:0", bytes: 2048 });
  });

  it("reports the error code and loads again on retry", async () => {
    const u = urls();
    const api = { fileBytes: vi.fn().mockRejectedValueOnce({ code: "io" }).mockResolvedValue(new Uint8Array(1)) };
    const s = new ImageSession(api, "W", "a.png", u.api);
    await s.load();
    expect(s.get()).toMatchObject({ status: "error", error: "io" });
    await s.load();
    expect(s.get().status).toBe("ready");
  });

  it("revokes the object URL on dispose and when it reloads", async () => {
    const { s, u } = await ready();
    await s.load();
    expect(u.revoked).toEqual(["blob:0"]);
    s.dispose();
    expect(u.revoked).toEqual(["blob:0", "blob:1"]);
  });

  it("does not create a URL for a load that was disposed first", async () => {
    const u = urls();
    const s = new ImageSession(bytes(), "W", "a.png", u.api);
    const p = s.load();
    s.dispose();
    await p;
    expect(u.made).toEqual([]);
  });

  it("fits without upscaling a raster image and shows 100% for fit", async () => {
    const { s } = await ready("a.png", { w: 100, h: 50 });
    expect(s.fit()).toBe(1);
    expect(s.percent()).toBe(100);
    expect(s.origin()).toEqual({ x: 166, y: 91 });
  });

  it("upscales an svg to fit", async () => {
    const { s } = await ready("a.svg", { w: 100, h: 50 });
    expect(s.fit()).toBeGreaterThan(1);
  });

  it("zooms in and out by 1.25 around the centre, and fit resets", async () => {
    const { s } = await ready("a.png", { w: 100, h: 50 });
    s.zoomIn();
    expect(s.get().zoom).toBe(1.25);
    expect(s.percent()).toBe(125);
    s.zoomOut();
    s.zoomOut();
    expect(s.get().zoom).toBe(0.8);
    s.reset();
    expect(s.get()).toMatchObject({ zoom: 1, pan: null });
  });

  it("stops at 8x and 0.25x", async () => {
    const { s } = await ready("a.png", { w: 100, h: 50 });
    for (let i = 0; i < 30; i++) s.zoomIn();
    expect(s.get().zoom).toBe(8);
    for (let i = 0; i < 60; i++) s.zoomOut();
    expect(s.get().zoom).toBe(0.25);
  });

  it("actual size is 100% of the image's own pixels", async () => {
    const { s } = await ready("a.png", { w: 800, h: 400 });
    expect(s.percent()).toBe(50);
    s.actual();
    expect(s.percent()).toBe(100);
    expect(s.scale()).toBeCloseTo(1);
  });

  it("takes zoom and pan from the viewport, and drag pans", async () => {
    const { s } = await ready("a.png", { w: 100, h: 50 });
    s.onZoom({ zoom: 2, x: 5, y: 6 });
    expect(s.get()).toMatchObject({ zoom: 2, pan: { x: 5, y: 6 } });
    s.onPan(9, 9);
    expect(s.origin()).toEqual({ x: 9, y: 9 });
  });
});
