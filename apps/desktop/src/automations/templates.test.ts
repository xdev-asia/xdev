import { describe, expect, it } from "vitest";
import { translate } from "@/i18n";
import { TEMPLATES, templateById } from "./templates";
import { toRrule } from "./schedule";

describe("templates", () => {
  it("has the four templates", () => {
    expect(TEMPLATES.map((t) => t.id)).toEqual(["repo-health-weekday", "release-prep-weekly", "recurring-review-daily", "maintenance-hourly"]);
  });

  it("sets each schedule and grace", () => {
    expect(toRrule(templateById("repo-health-weekday")!.schedule)).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=9;BYMINUTE=0");
    expect(templateById("repo-health-weekday")!.graceMinutes).toBe(720);
    expect(toRrule(templateById("release-prep-weekly")!.schedule)).toBe("FREQ=WEEKLY;BYDAY=TH;BYHOUR=14;BYMINUTE=0");
    expect(templateById("release-prep-weekly")!.graceMinutes).toBe(1440);
    expect(toRrule(templateById("recurring-review-daily")!.schedule)).toBe("FREQ=DAILY;BYHOUR=16;BYMINUTE=30");
    expect(templateById("recurring-review-daily")!.graceMinutes).toBe(180);
    expect(toRrule(templateById("maintenance-hourly")!.schedule)).toBe("FREQ=HOURLY;BYMINUTE=15");
    expect(templateById("maintenance-hourly")!.graceMinutes).toBe(30);
  });

  it("has its copy in both languages and never names another product", () => {
    for (const t of TEMPLATES) {
      for (const locale of ["en", "vi"] as const) {
        for (const field of ["name", "label", "description", "prompt"]) {
          const text = translate(locale, `automations.templates.${t.id}.${field}`);
          expect(text, `${t.id}.${field}`).not.toContain("automations.templates");
          expect(text.length).toBeGreaterThan(3);
        }
      }
    }
    expect(translate("en", "automations.templates.repo-health-weekday.name")).toBe("Weekday repo audit");
  });

  it("finds a template by id", () => {
    expect(templateById("nope")).toBeUndefined();
  });
});
