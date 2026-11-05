import type { ScheduleDraft } from "./schedule";

export type TemplateId = "repo-health-weekday" | "release-prep-weekly" | "recurring-review-daily" | "maintenance-hourly";
export type TemplateCategory = "maintenance" | "review" | "release";

export interface AutomationTemplate {
  id: TemplateId;
  category: TemplateCategory;
  schedule: ScheduleDraft;
  graceMinutes: number;
}

const draft = (preset: ScheduleDraft["preset"], hour: number, minute: number, dayOfWeek = 1): ScheduleDraft => ({ preset, hour, minute, dayOfWeek, cron: "" });

/** Name, label, description and prompt are `automations.templates.<id>.*` in the dictionaries. */
export const TEMPLATES: readonly AutomationTemplate[] = [
  { id: "repo-health-weekday", category: "maintenance", schedule: draft("weekdays", 9, 0), graceMinutes: 720 },
  { id: "release-prep-weekly", category: "release", schedule: draft("weekly", 14, 0, 4), graceMinutes: 1440 },
  { id: "recurring-review-daily", category: "review", schedule: draft("daily", 16, 30), graceMinutes: 180 },
  { id: "maintenance-hourly", category: "maintenance", schedule: draft("hourly", 0, 15), graceMinutes: 30 },
];

export function templateById(id: string): AutomationTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
