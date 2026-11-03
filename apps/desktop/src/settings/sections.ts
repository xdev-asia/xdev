import type { JSX } from "react";
import type { Api } from "@/api";
import { AgentsPage } from "./agents/AgentsPage";
import { GitSettings } from "./GitSettings";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { ReposSettings } from "./ReposSettings";
import { TerminalPage } from "./TerminalPage";
import { VaultsSettings } from "./VaultsSettings";

export interface SettingsSectionProps {
  api: Api;
  // Something the workspace lists changed, so it reloads.
  onChanged(): void;
  // A search the section starts with (Shortcuts: an action id the toast asked for).
  filter?: string;
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view, in order; another section is one more entry.
export const SECTIONS: SettingsSection[] = [
  { id: "agents", labelKey: "settings.agents.title", Component: AgentsPage },
  { id: "notifications", labelKey: "settings.notifications.title", Component: NotificationsPage },
  { id: "terminal", labelKey: "settings.terminal.title", Component: TerminalPage },
  { id: "repos", labelKey: "settings.repos.title", Component: ReposSettings },
  { id: "git", labelKey: "settings.git.title", Component: GitSettings },
  { id: "vaults", labelKey: "settings.vaults.title", Component: VaultsSettings },
];
