import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { MenuEntry } from "@xdev-asia/ui";
import type { SshConnState, SshConnectionView } from "@/api";
import { translate } from "@/i18n";
import { createMockSsh } from "@/mockSsh";
import { SshStatusItem, SshStatusView, sshMenuEntries, sshSegment } from "./SshStatusItem";
import { WorkspaceFooter } from "./WorkspaceFooter";

vi.mock("@/i18n", async (original) => ({ ...await original<typeof import("@/i18n")>(), useI18n: () => ({ locale: "en", setLocale() {}, t: (key: string, vars?: Record<string, string | number>) => translate("en", key, vars) }) }));

const en = (key: string, vars?: Record<string, string | number>) => translate("en", key, vars);
const view = (hostId: string, alias: string, state: SshConnState): SshConnectionView => ({ hostId, alias, state });
const labels = (entries: MenuEntry[]) => entries.map((e) => (e.type === "separator" ? "---" : e.label));
const select = (entries: MenuEntry[], label: string) => {
  const found = entries.find((e) => e.type !== "separator" && e.type !== "group" && e.label === label);
  if (!found || found.type === "separator" || found.type === "group") throw new Error(`no item ${label}`);
  found.onSelect?.();
};

it("the segment counts live connections and is hidden with none", () => {
  expect(sshSegment([])).toBeNull();
  expect(sshSegment([view("1", "web", { kind: "disconnected" }), view("2", "db", { kind: "failed", reason: "unreachable" })])).toBeNull();
  expect(sshSegment([view("1", "web", { kind: "connected" }), view("2", "db", { kind: "connecting" }), view("3", "x", { kind: "connected" })])).toEqual({ connected: 2, connecting: 1 });
});

it("the menu lists each host with its state and the actions that fit it", () => {
  const calls: string[] = [];
  const act = {
    connect: (id: string) => calls.push(`connect ${id}`),
    disconnect: (id: string) => calls.push(`disconnect ${id}`),
    openTerminal: (alias: string) => calls.push(`terminal ${alias}`),
    manage: () => calls.push("manage"),
  };
  const conns = new Map<string, SshConnState>([["1", { kind: "connected" }]]);
  const entries = sshMenuEntries([{ id: "1", alias: "web" }, { id: "2", alias: "db" }], conns, en, act);
  expect(labels(entries)).toEqual([
    `web · ${en("ssh.conn.connected")}`,
    en("ssh.footer.disconnect", { alias: "web" }),
    en("ssh.footer.openTerminal", { alias: "web" }),
    `db · ${en("ssh.conn.disconnected")}`,
    en("ssh.footer.connect", { alias: "db" }),
    en("ssh.footer.openTerminal", { alias: "db" }),
    "---",
    en("ssh.footer.manage"),
  ]);
  select(entries, en("ssh.footer.disconnect", { alias: "web" }));
  select(entries, en("ssh.footer.connect", { alias: "db" }));
  select(entries, en("ssh.footer.openTerminal", { alias: "db" }));
  select(entries, en("ssh.footer.manage"));
  expect(calls).toEqual(["disconnect 1", "connect 2", "terminal db", "manage"]);

  const bare = sshMenuEntries([], new Map(), en, { ...act, openTerminal: undefined });
  expect(labels(bare)).toEqual([en("ssh.footer.manage")]);
  const noTerminal = sshMenuEntries([{ id: "1", alias: "web" }], new Map(), en, { ...act, openTerminal: undefined });
  expect(labels(noTerminal)).not.toContain(en("ssh.footer.openTerminal", { alias: "web" }));
});

it("the view shows a dot and the count, and the menu when open", () => {
  const entries = sshMenuEntries([{ id: "1", alias: "web" }], new Map<string, SshConnState>([["1", { kind: "connected" }]]), en, { connect() {}, disconnect() {}, manage() {} });
  const closed = renderToStaticMarkup(<SshStatusView segment={{ connected: 1, connecting: 1 }} entries={entries} open={false} onToggle={() => {}} onClose={() => {}} />);
  expect(closed).toContain('data-action="ssh"');
  expect(closed).toContain(en("ssh.footer.item", { count: 2 }));
  expect(closed).toContain(en("ssh.footer.label", { connected: 1, connecting: 1 }));
  expect(closed).toContain('data-tone="ok"');
  expect(closed).not.toContain('role="menu"');
  const connecting = renderToStaticMarkup(<SshStatusView segment={{ connected: 0, connecting: 1 }} entries={entries} open={false} onToggle={() => {}} onClose={() => {}} />);
  expect(connecting).toContain('data-tone="warn"');
  const open = renderToStaticMarkup(<SshStatusView segment={{ connected: 1, connecting: 0 }} entries={entries} open onToggle={() => {}} onClose={() => {}} />);
  expect(open).toContain('role="menu"');
  expect(open).toContain(en("ssh.footer.manage"));
});

it("the live item renders nothing until a host connects", () => {
  const api = createMockSsh([{ id: "1", alias: "web", hostName: "web", source: "manual", forwardAgent: false, localForwards: [], extraOptions: [] }]);
  expect(renderToStaticMarkup(<SshStatusItem api={api} onManage={() => {}} />)).toBe("");
});

it("the footer has an SSH slot and leaves it out when none is given", () => {
  const base = { branch: "main", running: 0, waiting: 0, quota: null, version: "0.3.0" };
  expect(renderToStaticMarkup(<WorkspaceFooter {...base} ssh={<span data-testid="ssh-slot" />} />)).toContain('data-testid="ssh-slot"');
  expect(renderToStaticMarkup(<WorkspaceFooter {...base} />)).not.toContain('data-action="ssh"');
});
