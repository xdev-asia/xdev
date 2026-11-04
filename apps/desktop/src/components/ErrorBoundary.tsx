import { Component, type ErrorInfo, type JSX, type ReactNode } from "react";
import { api } from "@/api";
import { reportSurfaceCrash } from "@/crash/surfaceReport";
import { useI18n } from "@/i18n";

/** What the window shows when a view throws while rendering, instead of going blank. */
export function CrashView(props: { error: Error }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="app-crash" role="alert">
      <h1 className="app-crash-title">{t("app.crash.title")}</h1>
      <p className="app-crash-body">{t("app.crash.body")}</p>
      <pre className="app-crash-detail">{props.error.message}</pre>
      <button type="button" className="btn-secondary" onClick={() => window.location.reload()}>
        {t("app.crash.reload")}
      </button>
    </div>
  );
}

/** Catches render errors below it; without one React unmounts the whole tree and leaves a white window. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error("[app.root] render crash", error, info.componentStack);
    const err = error instanceof Error ? error : new Error(String(error));
    void reportSurfaceCrash(api, {
      boundary: "app.root",
      surface: "App root",
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
      componentStack: info.componentStack ?? null,
      context: [],
    });
  }

  render(): ReactNode {
    return this.state.error ? <CrashView error={this.state.error} /> : this.props.children;
  }
}
