import type { JSX } from "react";
import type { Api } from "@/api";
import { ReposSettings } from "./ReposSettings";
import { VaultsSettings } from "./VaultsSettings";

export interface SettingsSectionProps {
  api: Api;
  // Something the workspace lists changed, so it reloads.
  onChanged(): void;
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view, in order; another section is one more entry.
export const SECTIONS: SettingsSection[] = [
  { id: "repos", labelKey: "settings.repos.title", Component: ReposSettings },
  { id: "vaults", labelKey: "settings.vaults.title", Component: VaultsSettings },
];
