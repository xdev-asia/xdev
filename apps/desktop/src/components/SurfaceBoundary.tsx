import { Component, type ErrorInfo, type JSX, type ReactNode } from "react";
import { Banner, Button } from "@xdev-asia/ui";
import { api as appApi, type Api } from "@/api";
import { reportSurfaceCrash } from "@/crash/surfaceReport";
import { useI18n } from "@/i18n";

export type ResetKey = string | number | boolean | null | undefined;

type Props = {
  // The boundary id, for example `sidebar.worktrees`.
  id: string;
  surface: string;
  // The error clears when this changes.
  resetKey?: ResetKey;
  titleKey?: string;
  bodyKey?: string;
  // `false` keeps the fallback but sends no report (the crash dialog's own boundary).
  report?: boolean;
  api?: Pick<Api, "crashRecordRender">;
  children: ReactNode;
};

type State = { error: Error | null; resetKey: ResetKey };

function Fallback(props: { titleKey: string; bodyKey: string; onRetry(): void }): JSX.Element {
  const { t } = useI18n();
  return (
    <Banner
      title={t(props.titleKey)}
      action={
        <div className="banner-actions">
          <Button variant="secondary" type="button" onClick={props.onRetry}>
            {t("boundary.retry")}
          </Button>
        </div>
      }
    >
      {t(props.bodyKey)}
    </Banner>
  );
}

/** Contains a render error to one part of the window. Retry, or a new `resetKey`, renders the children again. */
export class SurfaceBoundary extends Component<Props, State> {
  state: State = { error: null, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): { error: Error } {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { error: null, resetKey: props.resetKey };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error(`[${this.props.id}] render crash contained by boundary`, error, info.componentStack);
    if (this.props.report === false) return;
    const err = error instanceof Error ? error : new Error(String(error));
    void reportSurfaceCrash(this.props.api ?? appApi, {
      boundary: this.props.id,
      surface: this.props.surface,
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
      componentStack: info.componentStack ?? null,
      context: [],
    });
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children;
    return (
      <Fallback
        titleKey={this.props.titleKey ?? "boundary.title"}
        bodyKey={this.props.bodyKey ?? "boundary.body"}
        onRetry={() => this.setState({ error: null })}
      />
    );
  }
}
