import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
import { startBindingsSync } from "./keys/bindingsStore";
import { loadStatusSettings } from "./status/statusSettings";
import { startCustomSchemesSync } from "./terminal/customSchemes";
import { loadTerminalSettings, startSettingsSync } from "./terminal/terminalSettings";
import "@xdev-asia/ui/styles.css";
import "./styles/base.css";
import "./styles/welcome.css";
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
import "./styles/settings.css";
import "./styles/usageStats.css";
import "./styles/quickCommands.css";
import { startEditorSettingsSync } from "./files/editorSettings";
import { startNavigationSettingsSync } from "./settings/navigationSettings";
import { startUsageSync } from "./settings/usageSettings";
import { applyCachedTheme, startThemeSync } from "./ui/theme";
import "./styles/agentSessions.css";

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
// The shortcuts: keybindings.json over the defaults, and the terminal key policy.
startBindingsSync(api);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
