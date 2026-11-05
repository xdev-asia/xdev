import { describe, expect, it } from "vitest";
import { translate } from "@/i18n";
import { DEFAULT_DRAFT, GRACE_OPTIONS, TIMEOUT_OPTIONS, dayName, formatTime, graceLabel, label, presetOf, toRrule, type ScheduleDraft } from "./schedule";

const en = { locale: "en" as const, t: (k: string, v?: Record<string, string | number>) => translate("en", k, v) };
const vi = { locale: "vi" as const, t: (k: string, v?: Record<string, string | number>) => translate("vi", k, v) };

const draft = (over: Partial<ScheduleDraft>): ScheduleDraft => ({ ...DEFAULT_DRAFT, ...over });

describe("toRrule", () => {
  it("writes the stored form of each preset", () => {
    expect(toRrule(draft({ preset: "hourly", minute: 15 }))).toBe("FREQ=HOURLY;BYMINUTE=15");
    expect(toRrule(draft({ preset: "daily", hour: 16, minute: 30 }))).toBe("FREQ=DAILY;BYHOUR=16;BYMINUTE=30");
    expect(toRrule(draft({ preset: "weekdays", hour: 9, minute: 0 }))).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0");
    expect(toRrule(draft({ preset: "weekly", hour: 14, minute: 0, dayOfWeek: 4 }))).toBe("FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0");
    expect(toRrule(draft({ preset: "weekly", dayOfWeek: 0 }))).toContain("BYDAY=SU");
  });

  it("keeps a custom cron as typed, trimmed", () => {
    expect(toRrule(draft({ preset: "custom", cron: "  0 9 * * 1-5 " }))).toBe("0 9 * * 1-5");
  });

  it("keeps the time inside its range", () => {
    expect(toRrule(draft({ preset: "daily", hour: 99, minute: -4 }))).toBe("FREQ=DAILY;BYHOUR=23;BYMINUTE=0");
  });
});

describe("presetOf", () => {
  it("reads every preset back", () => {
    for (const d of [
      draft({ preset: "hourly", minute: 45 }),
      draft({ preset: "daily", hour: 7, minute: 5 }),
      draft({ preset: "weekdays", hour: 18, minute: 30 }),
      draft({ preset: "weekly", hour: 14, minute: 0, dayOfWeek: 6 }),
    ]) {
      expect(presetOf(toRrule(d))).toEqual(d);
    }
  });

  it("opens anything else as custom with its text", () => {
    expect(presetOf("0 9 1 * 1")).toEqual({ ...DEFAULT_DRAFT, preset: "custom", cron: "0 9 1 * 1" });
    expect(presetOf("FREQ=WEEKLY;BYDAY=MO,WE;BYHOUR=9")).toMatchObject({ preset: "custom" });
    expect(presetOf("FREQ=YEARLY")).toMatchObject({ preset: "custom" });
    // A part the presets do not write (INTERVAL) is not dropped by opening it as a preset.
    expect(presetOf("FREQ=HOURLY;INTERVAL=2")).toMatchObject({ preset: "custom", cron: "FREQ=HOURLY;INTERVAL=2" });
  });

  it("defaults a rule without a time to 9:00", () => {
    expect(presetOf("FREQ=DAILY")).toMatchObject({ preset: "daily", hour: 9, minute: 0 });
  });
});

describe("label", () => {
  it("writes the presets in English", () => {
    expect(label({ kind: "hourly", minute: 5 }, en)).toBe("Hourly at :05");
    expect(label({ kind: "daily", hour: 16, minute: 30 }, en)).toBe("Daily at 4:30 PM");
    expect(label({ kind: "weekdays", hour: 9, minute: 0 }, en)).toBe("Weekdays at 9:00 AM");
    expect(label({ kind: "weekly", hour: 14, minute: 0, dayOfWeek: 4 }, en)).toBe("Thursdays at 2:00 PM");
    expect(label({ kind: "custom", expression: "0 9 1 * 1" }, en)).toBe("Custom schedule");
    expect(label({ kind: "invalid" }, en)).toBe("Invalid schedule");
  });

  it("localizes the day and the time", () => {
    expect(label({ kind: "weekly", hour: 14, minute: 0, dayOfWeek: 4 }, vi)).toContain("14:00");
    expect(dayName(0, "en")).toBe("Sunday");
    expect(dayName(6, "en")).toBe("Saturday");
    expect(dayName(4, "vi")).not.toBe(dayName(4, "en"));
  });

  it("formats times per locale", () => {
    expect(formatTime(0, 5, "en")).toBe("12:05 AM");
    expect(formatTime(21, 0, "vi")).toContain("21:00");
  });
});

describe("options", () => {
  it("lists the grace and timeout choices", () => {
    expect(GRACE_OPTIONS).toEqual([0, 30, 60, 180, 720, 1440, 2880]);
    expect(TIMEOUT_OPTIONS).toEqual([30, 60, 120, 300, 600]);
    expect(graceLabel(0, en.t)).toBe("No grace");
    expect(graceLabel(720, en.t)).toBe("12 hours");
    expect(graceLabel(45, en.t)).toBe("45 minutes");
  });
});
