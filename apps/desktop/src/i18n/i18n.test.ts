import { describe, expect, it } from "vitest";
import { ERROR_CODES } from "../api";
import en from "./en.json";
import vi from "./vi.json";
import { detectLocale, translate } from "./index";

describe("i18n", () => {
  it("en and vi have identical keys", () => {
    expect(Object.keys(vi).sort()).toEqual(Object.keys(en).sort());
  });

  it("no empty strings", () => {
    for (const dict of [en, vi]) {
      for (const [key, value] of Object.entries(dict)) expect(value, key).not.toBe("");
    }
  });

  it("detectLocale follows the OS language", () => {
    expect(detectLocale("vi-VN")).toBe("vi");
    expect(detectLocale("vi")).toBe("vi");
    expect(detectLocale("en-US")).toBe("en");
    expect(detectLocale("fr-FR")).toBe("en");
    expect(detectLocale(undefined)).toBe("en");
  });

  it("translate fills vars", () => {
    expect(translate("en", "search.empty", { query: "abc" })).toContain("abc");
    expect(translate("vi", "search.count", { count: 3 })).toContain("3");
  });

  it("translate uses the singular form for a count of one", () => {
    expect(translate("en", "sidebar.count", { count: 1 })).toBe("1 doc");
    expect(translate("en", "sidebar.count", { count: 2 })).toBe("2 docs");
    expect(translate("en", "sidebar.count", { count: 0 })).toBe("0 docs");
    for (const key of Object.keys(en).filter((k) => k.endsWith(".one"))) {
      const base = key.slice(0, -4) as keyof typeof en;
      expect(en, key).toHaveProperty([base]);
      expect(en[key as keyof typeof en], key).toContain("{count}");
      expect(vi[key as keyof typeof vi], key).toBe(vi[base]);
    }
  });

  it("translate returns the key when missing", () => {
    expect(translate("vi", "nope.missing")).toBe("nope.missing");
  });

  it("every error code and skip reason is translated", () => {
    for (const code of ERROR_CODES) expect(en).toHaveProperty(`error.${code}`);
    for (const reason of ["too_large", "not_utf8"]) expect(en).toHaveProperty(`skip.${reason}`);
  });
});
