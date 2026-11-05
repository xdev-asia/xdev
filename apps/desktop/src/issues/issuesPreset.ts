import type { IssuesPreset } from "@/api";
import type { PrChip } from "./PrsList";

export type IssuesStart = { view: "issues" | "prs"; mine: boolean; chip: PrChip };

export const ISSUES_PRESETS: readonly IssuesPreset[] = ["all", "issues", "my_issues", "prs", "my_prs", "review"];

/** Where the Issues panel opens for a preset. The person moves freely after that. */
export function presetStart(preset: IssuesPreset): IssuesStart {
  switch (preset) {
    case "my_issues":
      return { view: "issues", mine: true, chip: "open" };
    case "prs":
      return { view: "prs", mine: false, chip: "open" };
    case "my_prs":
      return { view: "prs", mine: false, chip: "mine" };
    case "review":
      return { view: "prs", mine: false, chip: "review" };
    default:
      return { view: "issues", mine: false, chip: "open" };
  }
}

/** The Issues tab shows when the setting allows it, the shortcut pinned it, or it is the open tab. */
export function issuesTabVisible(show: boolean, pinned: boolean, active: boolean): boolean {
  return show || pinned || active;
}
