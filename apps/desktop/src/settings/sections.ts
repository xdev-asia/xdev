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
import { HostsPage } from "./HostsPage";
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
  openSection?(id: string, arg?: string): void;
  // Switches the window to another view (Automations opens the Automations view).
  openView?(view: string): void;
  // Opens a terminal tab running `profile` in the current worktree, named `title`; the tab id, or
  // `null` when no worktree is open (Agents: Install).
  openTerminal?(profile: string, title: string): string | null;
  // Hands the Settings view the page's save state. The view shows one SaveBar, and only while
  // `dirty`; a page that gets this does not draw its own Save. Pass `null` when nothing is pending.
  registerSave?(spec: SaveSpec | null): void;
}

/** What a page tells the Settings SaveBar. */
export interface SaveSpec {
  dirty: boolean;
  busy?: boolean;
  saveDisabled?: boolean;
  onSave(): void;
  onDiscard(): void;
}

export interface SettingsFilter {
  query: string;
  // Entry ids that match; a SettingRow whose id is not here renders nothing.
  ids: ReadonlySet<string>;
  // The entry the palette opened: scrolled into view and highlighted once.
  target?: string;
}

export type SettingsGroupId = "general" | "agent" | "project" | "terminal" | "connect" | "advanced";

/** The headings of the Settings list, in order: six groups. */
export const GROUPS: { id: SettingsGroupId; labelKey: string }[] = [
  { id: "general", labelKey: "settings.v2.group.general" },
  { id: "agent", labelKey: "settings.v2.group.agent" },
  { id: "project", labelKey: "settings.v2.group.project" },
  { id: "terminal", labelKey: "settings.v2.group.terminal" },
  { id: "connect", labelKey: "settings.v2.group.connect" },
  { id: "advanced", labelKey: "settings.v2.group.advanced" },
];

export interface SettingsSection {
  id: string;
  labelKey: string;
  group: SettingsGroupId;
  Component: (p: SettingsSectionProps) => JSX.Element;
}

// The left list of the Settings view: the groups in GROUPS order, each section under its group in
// this order; another section is one more entry. Section ids are the deep-link ids and did not
// change when the 30 sections moved from 5 groups to 6, so old links keep working.
export const SECTIONS: SettingsSection[] = [
  { id: "general", group: "general", labelKey: "settings.general.title", Component: GeneralPage },
  { id: "repos", group: "project", labelKey: "settings.repos.title", Component: ReposSettings },
  { id: "git", group: "project", labelKey: "settings.git.title", Component: GitSettings },
  { id: "terminal", group: "terminal", labelKey: "settings.terminal.title", Component: TerminalPage },
  { id: "editor", group: "terminal", labelKey: "files.settings.title", Component: EditorPage },
  { id: "code", group: "terminal", labelKey: "settings.code.title", Component: CodeIntelPage },
  { id: "openIn", group: "project", labelKey: "openIn.title", Component: OpenInPage },
  { id: "browser", group: "terminal", labelKey: "settings.browser.title", Component: BrowserPage },
  { id: "agents", group: "agent", labelKey: "settings.agents.title", Component: AgentsPage },
  { id: "orchestration", group: "agent", labelKey: "settings.orchestration.title", Component: OrchestrationPage },
  { id: "automations", group: "agent", labelKey: "settings.automations.title", Component: AutomationsSettingsPage },
  { id: "usage", group: "agent", labelKey: "settings.usage.title", Component: UsagePage },
  { id: "appearance", group: "general", labelKey: "settings.appearance.title", Component: AppearancePage },
  { id: "notifications", group: "general", labelKey: "settings.notifications.title", Component: NotificationsPage },
  { id: "keys", group: "general", labelKey: "keys.title", Component: ShortcutsPage },
  { id: "qcmd", group: "terminal", labelKey: "qcmd.title", Component: QuickCommandsPage },
  { id: "capture", group: "general", labelKey: "settings.capture.title", Component: CaptureSettings },
  { id: "voice", group: "general", labelKey: "settings.voice.title", Component: VoicePage },
  { id: "account", group: "connect", labelKey: "account.title", Component: AccountPage },
  { id: "vaults", group: "project", labelKey: "settings.vaults.title", Component: VaultsSettings },
  { id: "ssh", group: "connect", labelKey: "ssh.title", Component: SshPage },
  { id: "hosts", group: "connect", labelKey: "settings.hosts.title", Component: HostsPage },
  { id: "peers", group: "connect", labelKey: "peers.title", Component: PeersPage },
  { id: "mcp", group: "connect", labelKey: "settings.mcp.title", Component: McpPage },
  { id: "cloud", group: "connect", labelKey: "cloud.title", Component: CloudPage },
  { id: "trackers", group: "project", labelKey: "settings.trackers.title", Component: TrackersPage },
  { id: "cli", group: "advanced", labelKey: "settings.cli.title", Component: CliPage },
  { id: "advanced", group: "advanced", labelKey: "settings.advanced.title", Component: AdvancedPage },
  { id: "diagnostics", group: "advanced", labelKey: "settings.diagnostics.title", Component: DiagnosticsPage },
  { id: "experimental", group: "advanced", labelKey: "settings.experimental.title", Component: ExperimentalPage },
];
