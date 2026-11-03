import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/i18n";
import { ConnectAgent, mcpCommand, mcpConfig } from "./ConnectAgent";

const VAULT = "C:\\Users\\lan\\notes";

describe("ConnectAgent", () => {
  it.each([
    ["/srv/docs", "claude mcp add xdev -- xdev mcp /srv/docs"],
    ["/srv/my docs", 'claude mcp add xdev -- xdev mcp "/srv/my docs"'],
    ["/srv/it's", `claude mcp add xdev -- xdev mcp "/srv/it's"`],
    ["E:\\", "claude mcp add xdev -- xdev mcp E:\\"],
    ["$(x)", null],
    ["C:\\%TEMP%", null],
    ["/srv/a`b", null],
    ["/srv/hi!", null],
  ])("quotes path %s safely", (path, command) => {
    expect(mcpCommand(path)).toBe(command);
  });

  it("uses the CLI beside the app, quoted the same way", () => {
    const cli = "C:\\Program Files\\xDev\\xdev.exe";
    expect(mcpCommand("E:\\Docs\\xDev", cli)).toBe(
      'claude mcp add xdev -- "C:\\Program Files\\xDev\\xdev.exe" mcp E:\\Docs\\xDev',
    );
    expect(JSON.parse(mcpConfig("E:\\Docs", cli)).mcpServers.xdev.command).toBe(cli);
    const html = renderToStaticMarkup(
      <I18nProvider><ConnectAgent vaultPath="E:\\Docs" cliPath={cli} /></I18nProvider>,
    );
    expect(html).toContain("&quot;C:\\Program Files\\xDev\\xdev.exe&quot; mcp");
    expect(html).not.toContain("not found next to the app");
  });

  it("says when the CLI is not beside the app", () => {
    const html = renderToStaticMarkup(
      <I18nProvider><ConnectAgent vaultPath="/srv/docs" cliPath={null} /></I18nProvider>,
    );
    expect(html).toContain("not found next to the app");
    expect(html).toContain("claude mcp add xdev -- xdev mcp /srv/docs");
  });

  it("shows only JSON config and a hint for a path the shell would expand", () => {
    const html = renderToStaticMarkup(
      <I18nProvider><ConnectAgent vaultPath="/srv/$HOME" /></I18nProvider>,
    );
    expect(html).not.toContain("claude mcp add");
    expect(html).toContain("Use the JSON config for paths containing");
    expect(html).toContain("&quot;mcpServers&quot;");
    expect(html.match(/class="btn-secondary connect-copy"/g)).toHaveLength(1);
  });

  it("connect_agent_shows_command_for_vault", () => {
    expect(mcpCommand(VAULT)).toBe('claude mcp add xdev -- xdev mcp C:\\Users\\lan\\notes');
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
    expect(html).toContain("claude mcp add xdev -- xdev mcp /srv/docs");
    expect(html).toContain("&quot;mcpServers&quot;");
    expect(html.match(/class="btn-secondary connect-copy"/g)).toHaveLength(2);
    // Nothing is copied yet, so no status is announced.
    expect(html).not.toContain("connect-status");
  });
});
