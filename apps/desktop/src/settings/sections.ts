import type { JSX } from "react";
import type { Api } from "@/api";
import { AdvancedPage } from "./AdvancedPage";
import { AccountPage } from "./account/AccountPage";
import { AgentsPage } from "./agents/AgentsPage";
import { AppearancePage } from "./AppearancePage";
import { AutomationsSettingsPage } from "./AutomationsSettingsPage";
import { BrowserPage } from "./BrowserPage";
import { CaptureSettings } from "./capture/CaptureSettings";
import { VoicePage } from "./voice/VoicePage";
import { CodeIntelPage } from "./CodeIntelPage";
import { CliPage } from "./cli/CliPage";
import { DiagnosticsPage } from "./DiagnosticsPage";
import { EditorPage } from "./EditorPage";
import { ExperimentalPage } from "./ExperimentalPage";
import { GeneralPage } from "./GeneralPage";
import { GitSettings } from "./GitSettings";
import { McpPage } from "./mcp/McpPage";
import { OpenInPage } from "./OpenInPage";
import { OrchestrationPage } from "./orchestration/OrchestrationPage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { QuickCommandsPage } from "./quickCommands/QuickCommandsPage";
import { PeersPage } from "@/peers/PeersPage";
import { ReposSettings } from "./ReposSettings";
import { ShortcutsPage } from "./shortcuts/ShortcutsPage";
import { SshPage } from "./SshPage";
import { TerminalPage } from "./TerminalPage";
import { UsagePage } from "./UsagePage";
import { VaultsSettings } from "./VaultsSettings";
import { CloudPage } from "./cloud/CloudPage";
import { TrackersPage } from "./TrackersPage";

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
  // Switches the window to another view (Automations opens the Automations view).
  openView?(view: string): void;
}

export interface SettingsFilter {
  query: string;
  // Entry ids that match; a SettingRow whose id is not here renders nothing.
  ids: ReadonlySet<string>;
  // The entry the palette opened: scrolled into view and highlighted once.
  target?: string;
}

export type SettingsGroupId = "workspace" | "agents" | "interface" | "integrations" | "advanced";

/** The headings of the Settings list, in order. */
export const GROUPS: { id: SettingsGroupId; labelKey: string }[] = [
  { id: "workspace", labelKey: "settings.group.workspace" },
  { id: "agents", labelKey: "settings.group.agents" },
  { id: "interface", labelKey: "settings.group.interface" },
  { id: "integrations", labelKey: "settings.group.integrations" },
  { id: "advanced", labelKey: "settings.group.advanced" },
];

export interface SettingsSection {
  id: string;
  labelKey: string;
  group: SettingsGroupId;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view: the groups in GROUPS order, each section under its group in
// this order; another section is one more entry.
export const SECTIONS: SettingsSection[] = [
  { id: "general", group: "workspace", labelKey: "settings.general.title", Component: GeneralPage },
  { id: "repos", group: "workspace", labelKey: "settings.repos.title", Component: ReposSettings },
  { id: "git", group: "workspace", labelKey: "settings.git.title", Component: GitSettings },
  { id: "terminal", group: "workspace", labelKey: "settings.terminal.title", Component: TerminalPage },
  { id: "editor", group: "workspace", labelKey: "files.settings.title", Component: EditorPage },
  { id: "code", group: "workspace", labelKey: "settings.code.title", Component: CodeIntelPage },
  { id: "openIn", group: "workspace", labelKey: "openIn.title", Component: OpenInPage },
  { id: "browser", group: "workspace", labelKey: "settings.browser.title", Component: BrowserPage },
  { id: "agents", group: "agents", labelKey: "settings.agents.title", Component: AgentsPage },
  { id: "orchestration", group: "agents", labelKey: "settings.orchestration.title", Component: OrchestrationPage },
  { id: "automations", group: "agents", labelKey: "settings.automations.title", Component: AutomationsSettingsPage },
  { id: "usage", group: "agents", labelKey: "settings.usage.title", Component: UsagePage },
  { id: "appearance", group: "interface", labelKey: "settings.appearance.title", Component: AppearancePage },
  { id: "notifications", group: "interface", labelKey: "settings.notifications.title", Component: NotificationsPage },
  { id: "keys", group: "interface", labelKey: "keys.title", Component: ShortcutsPage },
  { id: "qcmd", group: "interface", labelKey: "qcmd.title", Component: QuickCommandsPage },
  { id: "capture", group: "interface", labelKey: "settings.capture.title", Component: CaptureSettings },
  { id: "voice", group: "interface", labelKey: "settings.voice.title", Component: VoicePage },
  { id: "account", group: "integrations", labelKey: "account.title", Component: AccountPage },
  { id: "vaults", group: "integrations", labelKey: "settings.vaults.title", Component: VaultsSettings },
  { id: "ssh", group: "integrations", labelKey: "ssh.title", Component: SshPage },
  { id: "peers", group: "integrations", labelKey: "peers.title", Component: PeersPage },
  { id: "mcp", group: "integrations", labelKey: "settings.mcp.title", Component: McpPage },
  { id: "cloud", group: "integrations", labelKey: "cloud.title", Component: CloudPage },
  { id: "trackers", group: "integrations", labelKey: "settings.trackers.title", Component: TrackersPage },
  { id: "cli", group: "advanced", labelKey: "settings.cli.title", Component: CliPage },
  { id: "advanced", group: "advanced", labelKey: "settings.advanced.title", Component: AdvancedPage },
  { id: "diagnostics", group: "advanced", labelKey: "settings.diagnostics.title", Component: DiagnosticsPage },
  { id: "experimental", group: "advanced", labelKey: "settings.experimental.title", Component: ExperimentalPage },
];
