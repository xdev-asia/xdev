import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "../i18n";
import { ConnectAgent, mcpCommand, mcpConfig } from "./ConnectAgent";

const VAULT = "C:\\Users\\lan\\notes";

describe("ConnectAgent", () => {
  it("connect_agent_shows_command_for_vault", () => {
    expect(mcpCommand(VAULT)).toBe('claude mcp add xdev -- xdev mcp "C:\\Users\\lan\\notes"');
    expect(mcpConfig(VAULT)).toBe(
      JSON.stringify({ mcpServers: { xdev: { command: "xdev", args: ["mcp", VAULT] } } }, null, 2),
    );
    expect(JSON.parse(mcpConfig(VAULT))).toEqual({ mcpServers: { xdev: { command: "xdev", args: ["mcp", VAULT] } } });
    expect(mcpConfig("/srv/docs")).toBe(
      '{\n  "mcpServers": {\n    "xdev": {\n      "command": "xdev",\n      "args": [\n        "mcp",\n        "/srv/docs"\n      ]\n    }\n  }\n}',
    );

    const html = renderToStaticMarkup(
      <I18nProvider>
        <ConnectAgent vaultPath="/srv/docs" />
      </I18nProvider>,
    );
    expect(html).toContain('<section class="connect-agent"');
    expect(html).toContain("Connect an agent");
    expect(html).toContain("claude mcp add xdev -- xdev mcp &quot;/srv/docs&quot;");
    expect(html).toContain("&quot;mcpServers&quot;");
    expect(html.match(/class="btn-secondary connect-copy"/g)).toHaveLength(2);
    // Nothing is copied yet, so no status is announced.
    expect(html).not.toContain("connect-status");
  });
});
