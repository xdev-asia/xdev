import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { startCrashBreadcrumbs } from "./crash/crashEvents";
import { markStartup } from "./startup/startupSteps";
import { startBindingsSync } from "./keys/bindingsStore";
import { loadStatusSettings } from "./status/statusSettings";
import { startCustomSchemesSync } from "./terminal/customSchemes";
import { loadTerminalSettings, startSettingsSync } from "./terminal/terminalSettings";
import "@xdev-asia/ui/styles.css";
import "./styles/base.css";
import "./styles/welcome.css";
import "./styles/agentLaunch.css";
import "./styles/shell.css";
import "./styles/docs.css";
import "./styles/changes.css";
import "./styles/agents.css";
import "./styles/accounts.css";
import "./styles/tasks.css";
import "./styles/squads.css";
import "./styles/kit.css";
import "./styles/terminal.css";
import "./styles/workspace.css";
import "./styles/review.css";
import "./styles/ports.css";
import "./styles/settings.css";
import "./styles/usageStats.css";
import "./styles/tabOutput.css";
import "./styles/quickCommands.css";
import "./styles/ssh.css";
import "katex/dist/katex.min.css";
import "./styles/preview-files.css";
import "./styles/paneChrome.css";
import "./styles/diagnostics.css";
import "./styles/mcp.css";
import "./styles/startup.css";
import { startEditorSettingsSync } from "./files/editorSettings";
import { startNavigationSettingsSync } from "./settings/navigationSettings";
import { startAutomationsSettingsSync } from "./settings/automationsSettings";
import { startUsageSync } from "./settings/usageSettings";
import { applyCachedTheme, startThemeSync } from "./ui/theme";
import "./styles/agentSessions.css";
import "./styles/automations.css";
import "./styles/composer.css";

// Before the first render, so the window opens in the theme it closed in.
applyCachedTheme();
startThemeSync(api);
// Shared copies load before the first pane; `settings://changed` keeps them current after that.
void loadStatusSettings(api);
void loadTerminalSettings(api);
startCustomSchemesSync(api);
startSettingsSync(api);
startEditorSettingsSync(api);
startNavigationSettingsSync(api);
startUsageSync(api);
startAutomationsSettingsSync(api);
// The shortcuts: keybindings.json over the defaults, and the terminal key policy.
startBindingsSync(api);
// Window errors and rejected promises are kept as breadcrumbs for the next crash report.
startCrashBreadcrumbs(api);

const renderStart = performance.now();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);

// The first frame after the render call: a step the startup report shows next to the Rust ones.
requestAnimationFrame(() => {
  void markStartup(api, { id: "ui.first_render", ok: true, ms: Math.round(performance.now() - renderStart) });
});
