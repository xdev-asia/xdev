import { Button, Card, EmptyState, IconButton, ListRow, Tag } from "@xdev-asia/ui";
import { useEffect, useState } from "react";
import type { JSX } from "react";
import type { Api } from "@/api";
import { openFile } from "@/files/openFile";
import { useI18n } from "@/i18n";
import { pushToast } from "@/workspace/toastStore";
import { MCP_FILES, MCP_STARTER, readMcpConfigs, type McpRow } from "./mcpInspect";

/** Settings → Repos → MCP configs: the servers each MCP file of a repo defines, and a way to start one. Env values are never shown. */
export function McpConfigs(props: { api: Pick<Api, "fileRead" | "fileWrite">; repoPath: string }): JSX.Element {
  const { api, repoPath } = props;
  const { t } = useI18n();
  const [rows, setRows] = useState<McpRow[] | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function refresh(): Promise<void> {
    setRows(await readMcpConfigs(api, repoPath));
  }

  useEffect(() => {
    let live = true;
    void readMcpConfigs(api, repoPath).then((next) => {
      if (live) setRows(next);
    });
    return () => {
      live = false;
    };
  }, [api, repoPath]);

  // `expected: null` means the file must not exist, so a file made meanwhile is never overwritten.
  async function create(): Promise<void> {
    setBusy(true);
    setFailed(false);
    try {
      const outcome = await api.fileWrite(repoPath, MCP_FILES[0], MCP_STARTER, "lf", null);
      if (outcome.type === "saved") pushToast({ text: t("settings.repos.mcp.created") });
      setConfirming(false);
      await refresh();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const missingStarter = rows !== null && rows.find((r) => r.rel === MCP_FILES[0])?.inspection.status === "missing";
  const found = (rows ?? []).filter((r) => r.inspection.status !== "missing");

  function summary(row: McpRow): string {
    const x = row.inspection;
    if (x.status === "valid") return t("settings.repos.mcp.servers", { count: x.servers.length });
    if (x.status === "invalid") return t(`settings.repos.mcp.invalid.${x.reason}`);
    if (x.status === "error") return t(`error.${x.code}`);
    return "";
  }

  return (
    <div className="ws-field" role="group" aria-label={t("settings.repos.mcp.title")}>
      <Card
        subtitle={t("settings.repos.mcp.hint")}
        actions={<IconButton type="button" icon="refresh" label={t("settings.repos.mcp.refresh")} onClick={() => void refresh()} />}
      >
        {found.map((row) => (
          <ul key={row.rel} className="settings-list mcp-file" data-rel={row.rel}>
            <ListRow
              as="li"
              title={<span className="ws-mono">{row.rel}</span>}
              meta={summary(row)}
              trailing={
                <Button type="button" variant="secondary" onClick={() => openFile({ worktree: repoPath, rel: row.rel })}>
                  {t("settings.repos.mcp.open")}
                </Button>
              }
            />
            {row.inspection.status === "valid" &&
              row.inspection.servers.map((server) => (
                <ListRow
                  as="li"
                  key={server.name}
                  title={server.name}
                  meta={t("settings.repos.mcp.env", { count: server.envCount })}
                  trailing={
                    <>
                      {server.disabled && <Tag>{t("settings.repos.mcp.disabled")}</Tag>}
                      <Tag>{server.transport}</Tag>
                    </>
                  }
                />
              ))}
            {row.inspection.status === "valid" && row.inspection.truncated && (
              <li className="settings-hint">{t("settings.repos.mcp.truncated", { count: row.inspection.servers.length })}</li>
            )}
          </ul>
        ))}
        {missingStarter && (
          <EmptyState
            title={t("settings.repos.mcp.empty")}
            actions={
              confirming ? (
                <>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => void create()}>
                    {t("settings.repos.mcp.confirm")}
                  </Button>
                  <Button type="button" variant="secondary" disabled={busy} onClick={() => setConfirming(false)}>
                    {t("settings.repos.mcp.cancel")}
                  </Button>
                </>
              ) : (
                <Button type="button" variant="secondary" onClick={() => setConfirming(true)}>
                  {t("settings.repos.mcp.add")}
                </Button>
              )
            }
          />
        )}
        {failed && (
          <p className="error-text" role="alert">
            {t("settings.repos.mcp.failed")}
          </p>
        )}
      </Card>
    </div>
  );
}
