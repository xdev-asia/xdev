import { tokensCss } from "@xdev/ui";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { I18nProvider } from "./i18n";
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
import "./styles/settings.css";

const style = document.createElement("style");
style.textContent = tokensCss();
document.head.prepend(style);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <I18nProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </I18nProvider>
  </StrictMode>,
);
