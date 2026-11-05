import { Badge, Button, IconButton, Switch, Tag } from "@xdev-asia/ui";
import { useCallback, useEffect, useState } from "react";
import type { JSX } from "react";
import { toApiError, type McpActivityView, type McpHealth, type McpToolView } from "@/api";
import { useI18n } from "@/i18n";
import { SettingRow } from "../SettingRow";
import type { SettingsSectionProps } from "../sections";
import { McpAddToRepo } from "./McpAddToRepo";
import { McpAgentCommands } from "./McpAgentCommands";

/** The log lists at most this many calls; the server keeps 200. */
export const ACTIVITY_SHOWN = 200;

/** Settings → MCP: the xDev server agents start as `xdev mcp`, the app tools it offers, and how to add it. */
export function McpPage(props: SettingsSectionProps): JSX.Element {
  const { api, filter } = props;
  const { t, locale } = useI18n();
  const [health, setHealth] = useState<McpHealth | null>(null);
  const [tools, setTools] = useState<McpToolView[] | null>(null);
  const [activity, setActivity] = useState<McpActivityView[] | null>(null);
  const [cliPath, setCliPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [announce, setAnnounce] = useState("");

  const check = useCallback(() => {
    setHealth(null);
    api.mcpHealth().then(setHealth, () => setHealth({ path: null, version: null, running: false }));
  }, [api]);
  const loadActivity = useCallback(() => {
    api.mcpActivity().then(setActivity, (e: unknown) => {
      setActivity([]);
      setError(toApiError(e).code);
    });
  }, [api]);

  useEffect(() => {
    check();
    loadActivity();
    api.mcpToolsGet().then(setTools, (e: unknown) => setError(toApiError(e).code));
    api.cliPath().then(setCliPath, () => setCliPath(null));
  }, [api, check, loadActivity]);

  async function toggle(tool: McpToolView, enabled: boolean): Promise<void> {
    setBusy(tool.name);
    setError(undefined);
    try {
      setTools(await api.mcpToolSet(tool.name, enabled));
      setAnnounce(t(enabled ? "settings.mcp.tools.on" : "settings.mcp.tools.off", { tool: tool.name }));
    } catch (e) {
      setError(toApiError(e).code);
    } finally {
      setBusy(undefined);
    }
  }

  const time = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" });
  const last = activity?.[0];

  return (
    <div className="settings-page mcp-page">
      <header className="settings-head">
        <h3>{t("settings.mcp.title")}</h3>
        <p>{t("settings.mcp.lead")}</p>
      </header>

      <SettingRow id="mcp.health" filter={filter}>
        <div className="diagnostics-row">
          <div className="diagnostics-text">
            <strong>
              {t("settings.mcp.health.title")}{" "}
              {health !== null && <Badge status={health.running ? "unchanged" : "changed"}>{t(health.running ? "settings.mcp.health.running" : "settings.mcp.health.down")}</Badge>}
            </strong>
            <span role="status" data-mcp="health">
              {health === null
                ? t("settings.mcp.health.checking")
                : health.running
                  ? t("settings.mcp.health.version", { version: health.version ?? "" })
                  : t("settings.mcp.health.hint")}
            </span>
            {health?.path && <span className="settings-path">{health.path}</span>}
            {last && <span data-mcp="last">{t("settings.mcp.health.last", { time: time.format(last.atMs) })}</span>}
          </div>
          <div className="settings-actions settings-actions-start">
            <Button type="button" variant="secondary" data-act="mcp-check" disabled={health === null} onClick={check}>
              {t("settings.mcp.health.check")}
            </Button>
          </div>
        </div>
      </SettingRow>

      <SettingRow id="mcp.tools" filter={filter}>
        <h4 className="settings-group">{t("settings.mcp.tools.title")}</h4>
        <p className="settings-hint">{t("settings.mcp.tools.hint")}</p>
        <ul className="settings-list mcp-tools" aria-label={t("settings.mcp.tools.title")}>
          {(tools ?? []).map((tool) => (
            <li key={tool.name} className="mcp-tool" data-tool={tool.name}>
              <Switch
                data-tool-switch={tool.name}
                checked={tool.enabled}
                disabled={busy === tool.name}
                onChange={(e) => void toggle(tool, e.target.checked)}
                label={
                  <span className="mcp-tool-text">
                    <span className="mcp-tool-name">
                      <span className="ws-mono">{tool.name}</span>
                      {tool.sensitive && <Tag tone="warn">{t("settings.mcp.tools.sensitive")}</Tag>}
                    </span>
                    <small className="settings-hint">{t(`settings.mcp.tool.${tool.name}`)}</small>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
        <p role="status" className="settings-hint" data-status="mcp-tools">
          {announce}
        </p>
        {error && (
          <p className="error-text" role="alert" data-error="mcp">
            {t(`error.${error}`)}
          </p>
        )}
      </SettingRow>

      <SettingRow id="mcp.activity" filter={filter}>
        <div className="mcp-activity-head">
          <h4 className="settings-group">{t("settings.mcp.activity.title")}</h4>
          <IconButton type="button" icon="refresh" label={t("settings.mcp.activity.refresh")} onClick={loadActivity} />
        </div>
        <p className="settings-hint">{t("settings.mcp.activity.hint", { count: ACTIVITY_SHOWN })}</p>
        {activity !== null && activity.length === 0 ? (
          <p className="settings-hint" data-mcp="activity-empty">
            {t("settings.mcp.activity.empty")}
          </p>
        ) : (
          <ul className="settings-list mcp-activity" aria-label={t("settings.mcp.activity.title")}>
            {(activity ?? []).slice(0, ACTIVITY_SHOWN).map((a) => (
              <li key={`${a.atMs}-${a.tool}`} className="mcp-call" data-ok={a.ok}>
                <span className="ws-mono">{a.tool}</span>
                <span className="mcp-call-meta">
                  <Tag tone={a.ok ? "default" : "warn"}>{t(a.ok ? "settings.mcp.activity.ok" : "settings.mcp.activity.error")}</Tag>
                  <span>{t("settings.mcp.activity.ms", { ms: a.durationMs })}</span>
                  <time dateTime={new Date(a.atMs).toISOString()}>{time.format(a.atMs)}</time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </SettingRow>

      <SettingRow id="mcp.addToRepo" filter={filter}>
        <h4 className="settings-group">{t("settings.mcp.add.title")}</h4>
        <McpAddToRepo api={api} cliPath={cliPath} />
      </SettingRow>

      <SettingRow id="mcp.agents" filter={filter}>
        <h4 className="settings-group">{t("settings.mcp.agents.title")}</h4>
        <McpAgentCommands cliPath={cliPath} />
      </SettingRow>
    </div>
  );
}
