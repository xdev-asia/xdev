import type { JSX } from "react";
import type { Api } from "@/api";
import { AccountPage } from "./account/AccountPage";
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
import { UsagePage } from "./UsagePage";
import { VaultsSettings } from "./VaultsSettings";

export interface SettingsSectionProps {
  api: Api;
  // Something the workspace lists changed, so it reloads.
  onChanged(): void;
  // What the opener asked the section to start with (Shortcuts: an action id, Repos: a repo id,
  // Quick commands: "new").
  arg?: string;
  // The settings search; set while a query is typed or a palette item asked for one control.
  filter?: SettingsFilter;
  // Switches the Settings view to another section (General links to Open In Apps).
  openSection?(id: string): void;
}

export interface SettingsFilter {
  query: string;
  // Entry ids that match; a SettingRow whose id is not here renders nothing.
  ids: ReadonlySet<string>;
  // The entry the palette opened: scrolled into view and highlighted once.
  target?: string;
}

export interface SettingsSection {
  id: string;
  labelKey: string;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view, in order; another section is one more entry.
export const SECTIONS: SettingsSection[] = [
  { id: "general", labelKey: "settings.general.title", Component: GeneralPage },
  { id: "account", labelKey: "account.title", Component: AccountPage },
  { id: "agents", labelKey: "settings.agents.title", Component: AgentsPage },
  { id: "usage", labelKey: "settings.usage.title", Component: UsagePage },
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
