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

  describe("zoom limits relative to the fit scale", () => {
    const big = { w: 8000, h: 6000 };
    it("gives PanZoom absolute limits: 0.25x to 8x of fit, and always reaching 100% of the pixels", async () => {
      const { s } = await ready("a.png", big);
      const fit = s.fit();
      expect(fit).toBeLessThan(0.1);
      const { min, max } = s.limits();
      expect(min).toBeCloseTo(0.25 * fit);
      expect(max).toBeCloseTo(Math.max(8 * fit, 1));
      const small = await ready("a.png", { w: 100, h: 50 });
      expect(small.s.limits()).toEqual({ min: 0.25, max: 8 });
    });
    it("a wheel zoom out from fit goes below fit, not up to an absolute 0.25", async () => {
      const { s } = await ready("a.png", big);
      const fit = s.fit();
      s.onZoom({ zoom: fit * 0.8, x: 0, y: 0 });
      expect(s.get().zoom).toBeCloseTo(0.8);
      s.onZoom({ zoom: fit * 0.001, x: 0, y: 0 });
      expect(s.get().zoom).toBe(0.25);
      s.onZoom({ zoom: 50, x: 0, y: 0 });
      expect(s.scale()).toBeCloseTo(1);
    });
    it("toolbar steps and the wheel agree on the limits", async () => {
      const { s } = await ready("a.png", big);
      for (let i = 0; i < 80; i++) s.zoomOut();
      expect(s.get().zoom).toBe(0.25);
      for (let i = 0; i < 80; i++) s.zoomIn();
      expect(s.scale()).toBeCloseTo(s.limits().max);
      const wheelFloor = s.limits().min / s.fit();
      expect(wheelFloor).toBeCloseTo(0.25);
    });
    it("the 0 key resets like the Fit button", async () => {
      const { s } = await ready("a.png", big);
      s.zoomIn();
      s.onPan(4, 4);
      s.onReset();
      expect(s.get()).toMatchObject({ zoom: 1, pan: null });
    });
  });

  describe("the expanded view", () => {
    it("follows the parent's current URL after a reload, but keeps its own zoom", async () => {
      const { s, u } = await ready("a.png");
      const v = s.view();
      expect(v.get().url).toBe("blob:0");
      v.setNatural(800, 400);
      v.setBox(432, 232);
      v.zoomIn();
      await s.load();
      expect(s.get().url).toBe("blob:1");
      expect(v.get().url).toBe("blob:1");
      expect(v.get().zoom).toBe(1.25);
      expect(u.revoked).toEqual(["blob:0"]);
    });
    it("shows nothing while the parent reloads, and the error if it fails", async () => {
      const u = urls();
      const api = { fileBytes: vi.fn().mockResolvedValueOnce(new Uint8Array(1)).mockRejectedValueOnce({ code: "io" }) };
      const s = new ImageSession(api, "W", "a.png", u.api);
      await s.load();
      const v = s.view();
      const reload = s.load();
      expect(v.get()).toMatchObject({ status: "loading", url: null });
      await reload;
      expect(v.get()).toMatchObject({ status: "error", error: "io", url: null });
    });
    it("picks the parent up again when re-attached (a remounted effect)", async () => {
      const { s } = await ready("a.png");
      const v = s.view();
      v.dispose();
      await s.load();
      v.attach();
      expect(v.get().url).toBe(s.get().url);
      await s.load();
      expect(v.get().url).toBe(s.get().url);
    });
    it("stops following when disposed, and never revokes the parent's URL", async () => {
      const { s, u } = await ready("a.png");
      const v = s.view();
      v.dispose();
      expect(u.revoked).toEqual([]);
      await s.load();
      expect(v.get().url).toBeNull();
      expect(u.revoked).toEqual(["blob:0"]);
    });
  });
});
