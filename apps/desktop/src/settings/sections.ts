import type { JSX } from "react";
import type { Api } from "@/api";
import { AgentsPage } from "./agents/AgentsPage";
import { EditorPage } from "./EditorPage";
import { GeneralPage } from "./GeneralPage";
import { GitSettings } from "./GitSettings";
import { OpenInPage } from "./OpenInPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { QuickCommandsPage } from "./quickCommands/QuickCommandsPage";
import { ReposSettings } from "./ReposSettings";
import { ShortcutsPage } from "./shortcuts/ShortcutsPage";
import { TerminalPage } from "./TerminalPage";
import { VaultsSettings } from "./VaultsSettings";

export interface SettingsSectionProps {
  api: Api;
  // Something the workspace lists changed, so it reloads.
  onChanged(): void;
  // A search the section starts with (Shortcuts: an action id the toast asked for).
  filter?: string;
  // Switches the Settings view to another section (General links to Open In Apps).
  openSection?(id: string): void;
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view, in order; another section is one more entry.
export const SECTIONS: SettingsSection[] = [
  { id: "general", labelKey: "settings.general.title", Component: GeneralPage },
  { id: "agents", labelKey: "settings.agents.title", Component: AgentsPage },
  { id: "notifications", labelKey: "settings.notifications.title", Component: NotificationsPage },
  { id: "terminal", labelKey: "settings.terminal.title", Component: TerminalPage },
  { id: "editor", labelKey: "files.settings.title", Component: EditorPage },
  { id: "repos", labelKey: "settings.repos.title", Component: ReposSettings },
  { id: "openIn", labelKey: "openIn.title", Component: OpenInPage },
  { id: "git", labelKey: "settings.git.title", Component: GitSettings },
  { id: "vaults", labelKey: "settings.vaults.title", Component: VaultsSettings },
  { id: "keys", labelKey: "keys.title", Component: ShortcutsPage },
  { id: "qcmd", labelKey: "qcmd.title", Component: QuickCommandsPage },
];
