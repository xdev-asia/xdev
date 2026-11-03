import { useState } from "react";
import type { JSX, KeyboardEvent } from "react";
import { useI18n } from "@/i18n";
import { ICON, Icon } from "./ChangesPanel";

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

// `kind` names the snippet's language (shell, json), so it is not translated.
function Snippet(props: { id: string; kind: string; text: string }): JSX.Element {
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
      <div className="connect-code">
        <div className="connect-snippet-head">
          <span className="connect-kind">{props.kind}</span>
          <button
            type="button"
            className="btn-secondary connect-copy"
            data-copy={copy}
            aria-describedby={props.id}
            onClick={() => void onCopy()}
          >
            <Icon d={copy === "copied" ? ICON.check : ICON.copy} size={14} />
            {t("connect.copy")}
          </button>
        </div>
        <pre className="commands" id={props.id}>
          {props.text}
        </pre>
      </div>
      {copy !== "idle" && (
        <span className="connect-status" data-copy={copy} role="status">
          {t(copy === "copied" ? "connect.copied" : "connect.copyFailed")}
        </span>
      )}
    </div>
  );
}

type Tab = "command" | "config";
const TABS: readonly Tab[] = ["command", "config"];

// How to point an MCP client at this vault; `xdev mcp` serves the docs and takes proposed edits.
export function ConnectAgent(props: { vaultPath: string; cliPath?: string | null }): JSX.Element {
  const { t } = useI18n();
  const [tab, setTab] = useState<Tab>("command");
  const cli = props.cliPath ?? "xdev";
  const command = mcpCommand(props.vaultPath, cli);

  // Arrow keys move between tabs, as in the WAI-ARIA tabs pattern.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>) {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    const to = e.key === "Home" ? TABS[0] : e.key === "End" ? TABS[TABS.length - 1] : step ? TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] : null;
    if (to === null || to === undefined) return;
    e.preventDefault();
    setTab(to);
    document.getElementById(`connect-tab-${to}`)?.focus();
  }

  return (
    <section className="connect-agent" aria-labelledby="connect-agent-title">
      <div className="connect-head">
        <span className="connect-icon" aria-hidden="true">
          <Icon d={ICON.plug} />
        </span>
        <h2 className="connect-title" id="connect-agent-title">
          {t("connect.title")}
        </h2>
      </div>
      <p className="connect-hint">{t("connect.hint")}</p>
      {props.cliPath === null && <p className="connect-hint">{t("connect.cliMissing")}</p>}
      <div className="connect-tabs" role="tablist" aria-labelledby="connect-agent-title">
        {TABS.map((key) => (
          <button
            key={key}
            type="button"
            role="tab"
            id={`connect-tab-${key}`}
            className="connect-tab"
            aria-selected={tab === key}
            aria-controls={`connect-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            onClick={() => setTab(key)}
            onKeyDown={onTabKey}
          >
            {t(`connect.${key}`)}
          </button>
        ))}
      </div>
      <div
        className="connect-panel"
        role="tabpanel"
        id="connect-panel-command"
        aria-labelledby="connect-tab-command"
        hidden={tab !== "command"}
      >
        {command === null ? (
          <p className="connect-hint">{t("connect.commandUnsafe")}</p>
        ) : (
          <Snippet id="connect-command" kind="shell" text={command} />
        )}
      </div>
      <div
        className="connect-panel"
        role="tabpanel"
        id="connect-panel-config"
        aria-labelledby="connect-tab-config"
        hidden={tab !== "config"}
      >
        <Snippet id="connect-config" kind="json" text={mcpConfig(props.vaultPath, cli)} />
      </div>
    </section>
  );
}
