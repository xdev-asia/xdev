import { useState } from "react";
import type { JSX } from "react";
import { useI18n } from "../i18n";

type Copy = "idle" | "copied" | "failed";

// Shell and JSON, so they stay in English whatever the UI language.
export function mcpCommand(vaultPath: string): string {
  return `claude mcp add xdev -- xdev mcp "${vaultPath}"`;
}

export function mcpConfig(vaultPath: string): string {
  return JSON.stringify({ mcpServers: { xdev: { command: "xdev", args: ["mcp", vaultPath] } } }, null, 2);
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
export function ConnectAgent(props: { vaultPath: string }): JSX.Element {
  const { t } = useI18n();
  return (
    <section className="connect-agent" aria-labelledby="connect-agent-title">
      <div className="pane-head">
        <span id="connect-agent-title">{t("connect.title")}</span>
      </div>
      <p className="connect-hint">{t("connect.hint")}</p>
      <div className="connect-snippets">
        <Snippet id="connect-command" label={t("connect.command")} text={mcpCommand(props.vaultPath)} />
        <Snippet id="connect-config" label={t("connect.config")} text={mcpConfig(props.vaultPath)} />
      </div>
    </section>
  );
}
