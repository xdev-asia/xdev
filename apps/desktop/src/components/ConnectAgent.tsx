import { useState } from "react";
import type { JSX } from "react";
import { useI18n } from "../i18n";

type Copy = "idle" | "copied" | "failed";

// Double quotes are the one quoting cmd, PowerShell and POSIX shells all read the same way,
// as long as nothing inside them is expanded; such paths get no command.
function shellArg(value: string): string | null {
  if (/^[A-Za-z0-9_./:\\-]+$/.test(value)) return value;
  return /["$`%!]/.test(value) ? null : `"${value}"`;
}

// Shell and JSON, so they stay in English whatever the UI language.
// `cli` is the CLI's absolute path when it ships beside the app, else the bare name on PATH.
export function mcpCommand(vaultPath: string, cli = "xdev"): string | null {
  const exe = shellArg(cli);
  const path = shellArg(vaultPath);
  return exe === null || path === null ? null : `claude mcp add xdev -- ${exe} mcp ${path}`;
}

export function mcpConfig(vaultPath: string, cli = "xdev"): string {
  return JSON.stringify({ mcpServers: { xdev: { command: cli, args: ["mcp", vaultPath] } } }, null, 2);
}

function Snippet(props: { id: string; label: string; text: string }): JSX.Element {
  const { t } = useI18n();
  const [copy, setCopy] = useState<Copy>("idle");

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(props.text);
      setCopy("copied");
    } catch {
      // Clipboard access can be denied; the text stays selectable so it can be copied by hand.
      setCopy("failed");
    }
  }

  return (
    <div className="connect-snippet">
      <div className="connect-snippet-head">
        <span id={props.id}>{props.label}</span>
        <button type="button" className="btn-secondary connect-copy" onClick={() => void onCopy()}>
          {t("connect.copy")}
        </button>
      </div>
      <pre className="commands" aria-labelledby={props.id}>
        {props.text}
      </pre>
      {copy !== "idle" && (
        <span className="connect-status" data-copy={copy} role="status">
          {t(copy === "copied" ? "connect.copied" : "connect.copyFailed")}
        </span>
      )}
    </div>
  );
}

// How to point an MCP client at this vault; `xdev mcp` serves the docs and takes proposed edits.
export function ConnectAgent(props: { vaultPath: string; cliPath?: string | null }): JSX.Element {
  const { t } = useI18n();
  const cli = props.cliPath ?? "xdev";
  const command = mcpCommand(props.vaultPath, cli);
  return (
    <section className="connect-agent" aria-labelledby="connect-agent-title">
      <div className="pane-head">
        <span id="connect-agent-title">{t("connect.title")}</span>
      </div>
      <p className="connect-hint">{t("connect.hint")}</p>
      {props.cliPath === null && <p className="connect-hint">{t("connect.cliMissing")}</p>}
      <div className="connect-snippets">
        {command === null ? (
          <p className="connect-hint">{t("connect.commandUnsafe")}</p>
        ) : (
          <Snippet id="connect-command" label={t("connect.command")} text={command} />
        )}
        <Snippet id="connect-config" label={t("connect.config")} text={mcpConfig(props.vaultPath, cli)} />
      </div>
    </section>
  );
}
