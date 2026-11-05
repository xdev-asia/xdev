import { CodeBlock } from "@xdev-asia/ui";
import type { JSX } from "react";
import { useI18n } from "@/i18n";
import { AGENT_CLIS, userCommand } from "./mcpEntry";

/** One command per agent CLI that adds xdev for the whole user. Shown and copied; xDev never runs them. */
export function McpAgentCommands(props: { cliPath: string | null }): JSX.Element {
  const { t } = useI18n();
  return (
    <div className="mcp-commands">
      <p className="settings-hint">{t("settings.mcp.agents.hint")}</p>
      {AGENT_CLIS.map((agent) => (
        <CodeBlock
          key={agent}
          code={userCommand(agent, props.cliPath)}
          language={t(`settings.mcp.agents.${agent}`)}
          labels={{ copy: t("settings.mcp.copy", { agent: t(`settings.mcp.agents.${agent}`) }), copied: t("settings.mcp.copied") }}
        />
      ))}
    </div>
  );
}
